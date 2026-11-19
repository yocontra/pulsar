import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	codexPending,
	codexPendingIn,
	codexReadStats,
} from "../src/harnesses/codex-interactions.ts";
import {
	formAnswer,
	formPrompt,
} from "../src/harnesses/opencode-interactions.ts";
import type { ServerPrompt, ServerReply } from "../src/harnesses/types.ts";
import { PulsarService } from "../src/service/index.ts";
import { ServerInteractions } from "../src/service/server-interactions.ts";
import { Store } from "../src/store.ts";
import { longestLoopBlock } from "./loop-probe.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const ORIGIN = "http://localhost:4100";
const rp = { rpId: "localhost", origins: [ORIGIN] };
const user = {
	kind: "human" as const,
	login: "me@example.com",
	node: "phone",
	verified: true,
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

// The shape OpenCode 2.2.5's question tool sends (read from a scratch server).
const FORM = {
	id: "frm_1",
	sessionID: "ses_1",
	title: "Questions",
	metadata: { kind: "question" },
	fields: [
		{
			key: "q0",
			title: "Color",
			description: "Which color?",
			type: "string",
			options: [
				{ value: "red", label: "Red", description: "Choose red" },
				{ value: "green", label: "Green" },
			],
			custom: true,
		},
		{
			key: "q1",
			title: "Sizes",
			description: "Which sizes?",
			type: "multiselect",
			options: [
				{ value: "S", label: "S" },
				{ value: "M", label: "M" },
			],
			custom: false,
		},
	],
};

describe("OpenCode forms", () => {
	test("a question form becomes typed questions; answers map back to values", () => {
		const m = formPrompt(FORM)!;
		expect(m.prompt).toEqual({
			kind: "question",
			questions: [
				{
					id: "q0",
					question: "Which color?",
					header: "Color",
					multiSelect: false,
					options: [
						{ label: "Red", description: "Choose red" },
						{ label: "Green" },
					],
					allowOther: true,
				},
				{
					id: "q1",
					question: "Which sizes?",
					header: "Sizes",
					multiSelect: true,
					options: [{ label: "S" }, { label: "M" }],
					allowOther: false,
				},
			],
		});
		expect(
			formAnswer(FORM, m.values, { q0: ["Green"], q1: ["S", "M"] }),
		).toEqual({ q0: "green", q1: ["S", "M"] });
		// Free text goes as typed.
		expect(formAnswer(FORM, m.values, { q0: ["teal"], q1: ["S"] })).toEqual({
			q0: "teal",
			q1: ["S"],
		});
	});
});

function setup(shared?: Store) {
	const store = shared ?? new Store(":memory:");
	const service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null, answerable: () => true },
	});
	cleanups.push(() => {
		service.stop();
		if (!shared) store.close();
	});
	const relay = new ServerInteractions({
		registry: service.registry,
		approvals: service.approvals,
	});
	cleanups.push(() => relay.stop());
	return { service, relay };
}

async function enroll(service: PulsarService) {
	const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: "localhost" });
	const o = await service.approvals.passkeys.registrationOptions(
		user.login,
		rp,
		{
			label: "iPhone",
		},
	);
	await service.approvals.passkeys.verifyRegistration(
		user.login,
		rp,
		auth.register(o),
	);
	return auth;
}

/** A harness server whose pending list the test controls. */
function fakeServer(
	initial: ServerPrompt[],
	replyResult: () => Promise<boolean> = async () => true,
) {
	let pending = initial;
	const replies: [string, ServerReply][] = [];
	return {
		source: {
			intervalMs: 10,
			pending: async () => pending,
			reply: async (p: ServerPrompt, r: ServerReply) => {
				replies.push([p.key, r]);
				const ok = await replyResult();
				if (ok) pending = pending.filter((x) => x.key !== p.key);
				return ok;
			},
		},
		set: (p: ServerPrompt[]) => {
			pending = p;
		},
		replies,
	};
}

const PERM: ServerPrompt = {
	key: "per_1",
	sessionId: "ses_1",
	kind: "permission",
	tool: "shell",
	input: { action: "shell", resources: ["echo hi > a.txt"] },
	prompt: null,
	sessionRules: ["shell: echo *"],
};

describe("server interactions", () => {
	test("a pending server prompt opens once; the app's answer goes back through the harness", async () => {
		const { service, relay } = setup();
		const auth = await enroll(service);
		const s = fakeServer([PERM]);
		await relay.poll("opencode", s.source);
		await relay.poll("opencode", s.source);
		const agentId = service.registry.agentId("opencode", "ses_1", null);
		const pending = service.approvals.pendingFor(agentId);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.sessionRules).toEqual(["shell: echo *"]);
		const id = pending[0]!.requestId;
		const o = await service.approvals.options(user, rp, id, "allow-session");
		await service.approvals.decide(user, rp, id, {
			decision: "allow-session",
			assertion: auth.assert((o as { options: { challenge: string } }).options),
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(s.replies).toEqual([
			["per_1", { decision: "allow-session", answer: null, note: null }],
		]);
	});

	test("a prompt that leaves the server's list was answered there", async () => {
		const { service, relay } = setup();
		await enroll(service);
		const s = fakeServer([PERM]);
		await relay.poll("opencode", s.source);
		const agentId = service.registry.agentId("opencode", "ses_1", null);
		const id = service.approvals.pendingFor(agentId)[0]!.requestId;
		s.set([]);
		await relay.poll("opencode", s.source);
		expect(service.approvals.get(id)?.state).toBe("answered-locally");
		expect(s.replies).toEqual([]);
	});

	test("an unreadable server keeps what is open", async () => {
		const { service, relay } = setup();
		await enroll(service);
		const s = fakeServer([PERM]);
		await relay.poll("opencode", s.source);
		await relay.poll("opencode", {
			...s.source,
			pending: async () => {
				throw new Error("down");
			},
		});
		const agentId = service.registry.agentId("opencode", "ses_1", null);
		expect(service.approvals.pendingFor(agentId)).toHaveLength(1);
	});
});

const PERM2: ServerPrompt = {
	...PERM,
	key: "per_2",
	input: { action: "shell", resources: ["ls"] },
};

/** Approves `id` from the app with a passkey assertion. */
async function approve(
	service: PulsarService,
	auth: SoftAuthenticator,
	id: string,
) {
	const o = await service.approvals.options(user, rp, id, "allow-once");
	await service.approvals.decide(user, rp, id, {
		decision: "allow-once",
		assertion: auth.assert((o as { options: { challenge: string } }).options),
	});
	await new Promise((r) => setTimeout(r, 0));
}

describe("server interactions: prompts shown again", () => {
	const agentId = (service: PulsarService) =>
		service.registry.agentId("opencode", "ses_1", null);

	test("a prompt still waiting after a daemon restart opens a new card", async () => {
		const store = new Store(":memory:");
		cleanups.push(() => store.close());
		const a = setup(store);
		await enroll(a.service);
		const s = fakeServer([PERM]);
		await a.relay.poll("opencode", s.source);
		const old = a.service.approvals.pendingFor(agentId(a.service))[0]!
			.requestId;
		// The daemon died: nothing ended the row, the next one expires it.
		const b = setup(store);
		b.service.approvals.expireStale();
		await b.relay.poll("opencode", s.source);
		const now = b.service.approvals.pendingFor(agentId(b.service));
		expect(now).toHaveLength(1);
		expect(now[0]!.requestId).not.toBe(old);
		expect(b.service.approvals.get(old)?.state).toBe("expired");
	});

	test("a refused ask is retried next poll and does not stop the other prompts", async () => {
		const store = new Store(":memory:");
		cleanups.push(() => store.close());
		const a = setup(store);
		await enroll(a.service);
		await a.relay.poll("opencode", fakeServer([PERM]).source);
		// A second daemon on the same store before the old prompt expired:
		// its row is still pending, so asking again is refused.
		const b = setup(store);
		const s = fakeServer([PERM, PERM2]);
		await b.relay.poll("opencode", s.source);
		const pending = () =>
			b.service.approvals
				.pendingFor(agentId(b.service))
				.map((x) => x.input.resources);
		expect(pending()).toEqual([["echo hi > a.txt"], ["ls"]]);
		b.service.approvals.expireStale();
		await b.relay.poll("opencode", s.source);
		expect(pending()).toEqual([["ls"], ["echo hi > a.txt"]]);
	});

	test("a prompt that leaves the list and comes back opens a new card", async () => {
		const { service, relay } = setup();
		await enroll(service);
		const s = fakeServer([PERM]);
		await relay.poll("opencode", s.source);
		const first = service.approvals.pendingFor(agentId(service))[0]!.requestId;
		s.set([]);
		await relay.poll("opencode", s.source);
		s.set([PERM]);
		await relay.poll("opencode", s.source);
		const now = service.approvals.pendingFor(agentId(service));
		expect(now).toHaveLength(1);
		expect(now[0]!.requestId).not.toBe(first);
		expect(service.approvals.get(first)?.state).toBe("answered-locally");
	});

	for (const [name, result] of [
		["returns false", async () => false],
		[
			"rejects",
			async () => {
				throw new Error("timeout");
			},
		],
	] as const)
		test(`a reply that ${name} is audited and the prompt is shown again`, async () => {
			const { service, relay } = setup();
			const auth = await enroll(service);
			const s = fakeServer([PERM], result);
			const notices: { kind: string; message: string }[] = [];
			const off = service.events.on("security", (n) => notices.push(n));
			cleanups.push(off);
			await relay.poll("opencode", s.source);
			const first = service.approvals.pendingFor(agentId(service))[0]!
				.requestId;
			await approve(service, auth, first);
			expect(s.replies).toHaveLength(1);
			// Every tab is told the answer did not get through.
			expect(notices).toHaveLength(1);
			expect(notices[0]!.kind).toBe("reply-failed");
			expect(notices[0]!.message).toContain("did not reach opencode on studio");
			const audit = service.store.db
				.prepare("SELECT op, target, ok FROM audit WHERE op = ?")
				.all("interaction.reply-failed");
			expect(audit).toEqual([
				{ op: "interaction.reply-failed", target: "opencode:per_1", ok: 0 },
			]);
			await relay.poll("opencode", s.source);
			const again = service.approvals.pendingFor(agentId(service));
			expect(again).toHaveLength(1);
			expect(again[0]!.requestId).not.toBe(first);
		});
});

describe("Codex (read-only)", () => {
	const call = (id: string, args: unknown) =>
		JSON.stringify({
			type: "response_item",
			payload: {
				type: "function_call",
				name: "request_user_input",
				call_id: id,
				arguments: JSON.stringify(args),
			},
		});
	const output = (id: string) =>
		JSON.stringify({
			type: "response_item",
			payload: { type: "function_call_output", call_id: id, output: "{}" },
		});
	const QS = {
		questions: [
			{
				id: "env",
				header: "Env",
				question: "Deploy to?",
				isOther: true,
				options: [{ label: "staging", description: "safe" }, { label: "prod" }],
			},
		],
	};

	test("an unanswered request_user_input in the rollout is a pending read-only question", () => {
		const text = [call("c1", QS), output("c1"), call("c2", QS)].join("\n");
		const got = codexPendingIn(text);
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({
			key: "c2",
			kind: "question",
			readOnly: true,
			prompt: {
				kind: "question",
				questions: [
					{
						id: "env",
						header: "Env",
						question: "Deploy to?",
						allowOther: true,
					},
				],
			},
		});
	});

	test("a 50 MB rollout is polled without blocking the loop, and unchanged bytes are not read again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-codex-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "rollout-thr_big.jsonl");
		// 50 MB of finished tool calls, then one open question.
		const chunk = Array.from({ length: 1000 }, (_, i) =>
			output(`o${i}`).replace('"{}"', JSON.stringify("x".repeat(1000))),
		).join("\n");
		writeFileSync(file, "");
		for (let n = 0; n < 50 * 1024 * 1024; n += chunk.length + 1)
			appendFileSync(file, `${chunk}\n`);
		appendFileSync(file, `${call("q1", QS)}\n`);
		const agents = [
			{ harness: "codex", sessionId: "thr_big", status: "idle" },
		] as never;
		const rollout = async () => file;

		const block = await longestLoopBlock(async () => {
			const before = codexReadStats.bytes;
			const first = await codexPending(agents, rollout);
			expect(first.map((p) => p.key)).toEqual(["q1"]);
			// Only the tail is read, never the whole file.
			expect(codexReadStats.bytes - before).toBeLessThanOrEqual(256 * 1024);
			const read = codexReadStats.bytes;
			for (let i = 0; i < 20; i++)
				expect((await codexPending(agents, rollout)).map((p) => p.key)).toEqual(
					["q1"],
				);
			// Unchanged: stat only, no bytes read.
			expect(codexReadStats.bytes).toBe(read);
			// The answer lands: the file is read again and the prompt ends.
			appendFileSync(file, `${output("q1")}\n`);
			expect(await codexPending(agents, rollout)).toEqual([]);
			expect(codexReadStats.bytes).toBeGreaterThan(read);
		});
		// Each tick's JS stays well under the daemon's 200 ms stall threshold,
		// counted in CPU on this thread: a loaded machine's OS starvation is not
		// the code blocking the loop.
		expect(block.cpuMs).toBeLessThan(25);
	});

	test("the app shows it but can't answer it; it ends when the rollout answers", async () => {
		const { service, relay } = setup();
		await enroll(service);
		const pending = codexPendingIn(call("c9", QS)).map((p) => ({
			...p,
			sessionId: "thr_1",
		}));
		const s = fakeServer(pending);
		await relay.poll("codex", s.source);
		const agentId = service.registry.agentId("codex", "thr_1", null);
		const ap = service.approvals.pendingFor(agentId)[0]!;
		expect(ap.readOnly).toBe(true);
		let refused = "";
		try {
			await service.approvals.options(user, rp, ap.requestId, "answer", {
				answer: { kind: "question", answers: { env: ["prod"] } },
			});
		} catch (e) {
			refused = (e as Error).message;
		}
		expect(refused).toContain("screen");
		s.set([]);
		await relay.poll("codex", s.source);
		expect(service.approvals.get(ap.requestId)?.state).toBe("answered-locally");
	});
});
