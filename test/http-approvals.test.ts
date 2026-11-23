import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StaticIdentity } from "../src/http/identity.ts";
import type {
	Approval,
	AttentionList,
	DecideResponse,
	Hello,
	SessionOptionsResponse,
	SessionVerifyResponse,
} from "../src/http/wire.ts";
import type { HookDecision } from "../src/service/approvals.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const OWNER = "me@example.com";
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
let origin: string;
let agentId: string;

async function api<T = Record<string, unknown>>(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = { "X-Pulsar": "1" },
): Promise<{ status: number; body: T }> {
	const res = await fetch(`${base}/api/v1${path}`, {
		method,
		headers: {
			...headers,
			Origin: origin,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	return { status: res.status, body: (await res.json()) as T };
}

/** Signs a passkey session with `key`; returns its bearer token. */
async function startSession(key: SoftAuthenticator, device: string) {
	const o = await api<SessionOptionsResponse>("POST", "/session/options", {
		device,
	});
	expect(o.status).toBe(200);
	const v = await api<SessionVerifyResponse>("POST", "/session/verify", {
		requestId: o.body.requestId,
		assertion: key.assert(o.body.options as never),
	});
	expect(v.status).toBe(200);
	return v.body.token;
}

function ask(command: string) {
	const ac = new AbortController();
	const caller: Caller = {
		principal: { kind: "agent", agentId },
		closed: ac.signal,
		emit() {},
	};
	const decision = service.approvals.request(caller, {
		sessionId: "web-1",
		promptId: "turn-1",
		tool: "Bash",
		input: { command },
		suggestions: [],
		cwd: "/repo",
		transcriptPath: null,
	});
	const id = service.approvals.pendingFor(agentId).at(-1)!.requestId;
	return { id, decision, close: () => ac.abort() };
}

beforeAll(async () => {
	store = new Store(":memory:");
	service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null, answerable: () => true },
	});
	agentId = service.registry.upsert({
		harness: "claude",
		sessionId: "web-1",
		pid: null,
		cwd: "/repo",
		project: "repo",
		branch: "main",
		tags: [],
		meta: {},
		registered: true,
	}).id;
	http = new HttpTransport(service, {
		identity: new StaticIdentity(OWNER, "phone", "dev", { os: "iOS" }),
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		hub: { coalesceMs: 40 },
	});
	await http.listen();
	base = `http://127.0.0.1:${http.port}`;
	origin = `http://localhost:${http.port}`;
});

afterAll(async () => {
	await http.close();
	service.stop();
	store.close();
});

describe("approvals over HTTP", () => {
	let auth: SoftAuthenticator;

	test("hello lists the approvals feature; the RP is localhost in development", async () => {
		const r = await api<Hello>("GET", "/hello");
		expect(r.body.features).toContain("approvals");
		expect(http.relyingParty().rpId).toBe("localhost");
	});

	test("registering needs no code; it's audited, announced and listed; the operator can remove one", async () => {
		const ac = new AbortController();
		const res = await fetch(`${base}/api/v1/events`, {
			headers: { "X-Pulsar": "1" },
			signal: ac.signal,
		});
		let text = "";
		const reader = res.body!.getReader();
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					text += new TextDecoder().decode(value);
				}
			} catch {}
		})();
		await until(() => text.includes("event: ready"));
		// A spare key, removed again below.
		const spare = new SoftAuthenticator({ origin, rpId: "localhost" });
		const so = await api<{ options: { challenge: string } }>(
			"POST",
			"/passkeys/register/options",
			{
				label: "Old phone",
			},
		);
		await api("POST", "/passkeys/register/verify", {
			response: spare.register(so.body.options),
		});
		await until(() => text.includes("New passkey 'Old phone' added on studio"));
		const list = await api<{ items: { id: string; label: string }[] }>(
			"GET",
			"/passkeys",
		);
		expect(list.body.items.map((p) => p.label)).toEqual(["Old phone"]);
		const removePath = `/passkeys/${encodeURIComponent(list.body.items[0]!.id)}/remove`;
		// Without a passkey session (Face ID / Touch ID), removal is refused.
		const unverified = await api<{ error: { code: string } }>(
			"POST",
			removePath,
			{},
		);
		expect(unverified.status).toBe(401);
		expect(unverified.body.error.code).toBe("session_required");
		const token = await startSession(spare, "Old phone");
		const rm = await api(
			"POST",
			removePath,
			{},
			{
				"X-Pulsar": "1",
				Authorization: `Bearer ${token}`,
			},
		);
		expect(rm.status).toBe(200);
		await until(() => text.includes("Passkey 'Old phone' removed on studio"));
		ac.abort();

		auth = new SoftAuthenticator({ origin, rpId: "localhost" });
		const o = await api<{ options: { challenge: string } }>(
			"POST",
			"/passkeys/register/options",
			{ label: "iPhone" },
		);
		expect(o.status).toBe(200);
		const v = await api("POST", "/passkeys/register/verify", {
			response: auth.register(o.body.options),
		});
		expect(v.status).toBe(200);
		expect(v.body.label).toBe("iPhone");
		// No code for a second device either: the operator's identity and the
		// passkey's user verification are the proof.
		const again = await api("POST", "/passkeys/register/options", {
			label: "Mac",
		});
		expect(again.status).toBe(200);
	});

	test("a prompt reaches attention and SSE at once; a signed decision releases the hook", async () => {
		const ac = new AbortController();
		const res = await fetch(`${base}/api/v1/events`, {
			headers: { "X-Pulsar": "1" },
			signal: ac.signal,
		});
		let text = "";
		const reader = res.body!.getReader();
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					text += new TextDecoder().decode(value);
				}
			} catch {}
		})();
		await until(() => text.includes("event: ready"));
		const p = ask("echo hi");
		await until(() => text.includes("event: approval"), 1000);
		const att = await api<AttentionList>("GET", "/attention");
		expect(att.body.items[0]?.approval?.requestId).toBe(p.id);
		const got = await api<Approval>(
			"GET",
			`/approvals/${encodeURIComponent(p.id)}`,
		);
		expect(got.body.input).toEqual({ command: "echo hi" });

		const o = await api<{ options: { challenge: string } }>(
			"POST",
			`/approvals/${encodeURIComponent(p.id)}/options`,
			{ decision: "allow-once" },
		);
		expect(o.status).toBe(200);
		const d = await api<DecideResponse>(
			"POST",
			`/approvals/${encodeURIComponent(p.id)}/decide`,
			{ decision: "allow-once", assertion: auth.assert(o.body.options) },
		);
		expect(d.status).toBe(200);
		expect(d.body.won).toBe(true);
		expect(d.body.approval.outcome).toMatch(
			/^Allowed once by me@example.com · Face ID on iOS \(phone\)/,
		);
		expect((await p.decision) as HookDecision).toEqual({ behavior: "allow" });
		await until(() => text.split("event: approval").length >= 3, 1000);
		ac.abort();
	});

	test("refusals: no header, a bad assertion, a decided prompt", async () => {
		const p = ask("rm -rf build");
		const path = `/approvals/${encodeURIComponent(p.id)}`;
		const noHeader = await api(
			"POST",
			`${path}/options`,
			{ decision: "deny" },
			{},
		);
		expect(noHeader.status).toBe(403);
		const bad = await api<{ error: { code: string } }>(
			"POST",
			`${path}/decide`,
			{
				decision: "deny",
				assertion: { id: "x", response: {} },
			},
		);
		expect(bad.status).toBe(403);
		expect(bad.body.error.code).toBe("bad_assertion");
		p.close();
		await p.decision;
		const late = await api<{ error: { code: string } }>(
			"POST",
			`${path}/options`,
			{
				decision: "deny",
			},
		);
		expect(late.status).toBe(409);
		expect(late.body.error.code).toBe("decided");
		const strict = await api("POST", `${path}/decide`, {
			decision: "maybe",
			assertion: {},
		});
		expect(strict.status).toBe(400);
	});

	test("an AskUserQuestion is answered over HTTP with a signed answer", async () => {
		const ac = new AbortController();
		const caller: Caller = {
			principal: { kind: "agent", agentId },
			closed: ac.signal,
			emit() {},
		};
		const input = {
			questions: [
				{
					question: "Which db?",
					header: "DB",
					multiSelect: false,
					options: [{ label: "Postgres" }, { label: "SQLite" }],
				},
			],
		};
		const decision = service.approvals.request(caller, {
			sessionId: "web-1",
			promptId: "turn-q",
			tool: "AskUserQuestion",
			input,
			suggestions: [],
			cwd: "/repo",
			transcriptPath: null,
		});
		const id = service.approvals.pendingFor(agentId).at(-1)!.requestId;
		const path = `/approvals/${encodeURIComponent(id)}`;
		const got = await api<{ kind: string; prompt: { kind: string } }>(
			"GET",
			path,
		);
		expect(got.body.kind).toBe("question");
		expect(got.body.prompt.kind).toBe("question");
		const answer = { kind: "question", answers: { "Which db?": ["SQLite"] } };
		// An answer that isn't an option (free text is allowed) vs a malformed one.
		const malformed = await api("POST", `${path}/options`, {
			decision: "answer",
			answer: { kind: "question", answers: { "Which db?": ["a", "b"] } },
		});
		expect(malformed.status).toBe(400);
		const o = await api<{ options: { challenge: string } }>(
			"POST",
			`${path}/options`,
			{ decision: "answer", answer },
		);
		expect(o.status).toBe(200);
		const assertion = auth.assert(o.body.options);
		// The signature covers the answer: another answer with it is refused.
		const swapped = await api("POST", `${path}/decide`, {
			decision: "answer",
			answer: { kind: "question", answers: { "Which db?": ["Postgres"] } },
			assertion,
		});
		expect(swapped.status).toBe(403);
		const o2 = await api<{ options: { challenge: string } }>(
			"POST",
			`${path}/options`,
			{ decision: "answer", answer },
		);
		const d = await api<{ won: boolean; approval: { outcome: string } }>(
			"POST",
			`${path}/decide`,
			{ decision: "answer", answer, assertion: auth.assert(o2.body.options) },
		);
		expect(d.status).toBe(200);
		expect(d.body.won).toBe(true);
		expect(d.body.approval.outcome).toMatch(/^Answered: SQLite by /);
		expect(await decision).toEqual({
			behavior: "allow",
			updatedInput: { ...input, answers: { "Which db?": "SQLite" } },
		});
	});
});
