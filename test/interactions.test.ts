import { afterEach, describe, expect, test } from "bun:test";
import {
	classifyClaude,
	decideClaude,
} from "../src/harnesses/claude-interactions.ts";
import type { InteractionAnswer } from "../src/http/wire.ts";
import { RpcError } from "../src/rpc.ts";
import type {
	ApprovalRequest,
	InteractionRequest,
} from "../src/service/approvals.ts";
import type { Caller, Principal } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import {
	answerHash,
	cleanAnswer,
	cleanPrompt,
	SECRET,
} from "../src/service/interactions.ts";
import { Store } from "../src/store.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const ORIGIN = "http://localhost:4100";
const rp = { rpId: "localhost", origins: [ORIGIN] };
const user: Principal = {
	kind: "human",
	login: "me@example.com",
	node: "phone",
	os: "iOS",
	verified: true,
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function setup(harness = "claude") {
	const store = new Store(":memory:");
	const service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null, answerable: () => true },
	});
	cleanups.push(() => {
		service.stop();
		store.close();
	});
	const agent = service.registry.upsert({
		harness,
		sessionId: "sess-1",
		pid: null,
		cwd: "/repo",
		project: "repo",
		branch: "main",
		tags: [],
		meta: {},
		registered: true,
	});
	return { service, agent };
}

function conn(agentId: string): { caller: Caller; close: () => void } {
	const ac = new AbortController();
	return {
		caller: {
			principal: { kind: "agent", agentId },
			closed: ac.signal,
			emit() {},
		},
		close: () => ac.abort(),
	};
}

async function enroll(service: PulsarService) {
	const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: "localhost" });
	const options = await service.approvals.passkeys.registrationOptions(
		"me@example.com",
		rp,
		{ label: "iPhone" },
	);
	await service.approvals.passkeys.verifyRegistration(
		"me@example.com",
		rp,
		auth.register(options),
	);
	return auth;
}

const QUESTIONS = {
	questions: [
		{
			question: "Which fruits?",
			header: "Fruits",
			multiSelect: true,
			options: [
				{ label: "Apple", description: "red" },
				{ label: "Pear" },
				{ label: "Plum" },
			],
		},
		{
			question: "What size?",
			header: "Size",
			multiSelect: false,
			options: [{ label: "Small" }, { label: "Large" }],
		},
	],
};

const askReq = (
	tool: string,
	input: Record<string, unknown>,
): ApprovalRequest => ({
	sessionId: "sess-1",
	promptId: "turn-1",
	tool,
	input,
	suggestions: [],
	cwd: "/repo",
	transcriptPath: null,
});

function hookAsk(
	service: PulsarService,
	agentId: string,
	req: ApprovalRequest,
) {
	const h = conn(agentId);
	const decision = service.approvals.request(h.caller, req);
	const id = service.approvals.pendingFor(agentId).at(-1)?.requestId ?? "";
	return { ...h, decision, id };
}

async function answer(
	service: PulsarService,
	auth: SoftAuthenticator,
	id: string,
	a: InteractionAnswer,
) {
	const options = await service.approvals.options(user, rp, id, "answer", {
		answer: a,
	});
	const assertion = auth.assert(
		(options as { options: { challenge: string } }).options,
	);
	return service.approvals.decide(user, rp, id, {
		decision: "answer",
		answer: a,
		assertion,
	});
}

async function code(
	p: Promise<unknown> | (() => unknown),
): Promise<string | null> {
	try {
		await (typeof p === "function" ? p() : p);
		return null;
	} catch (e) {
		return e instanceof RpcError ? e.code : String(e);
	}
}

describe("Claude adapter", () => {
	test("AskUserQuestion becomes a question keyed by its text, with free text allowed", () => {
		const p = classifyClaude("AskUserQuestion", QUESTIONS);
		expect(p?.kind).toBe("question");
		if (p?.kind !== "question") return;
		expect(p.questions.map((q) => q.id)).toEqual([
			"Which fruits?",
			"What size?",
		]);
		expect(p.questions[0]).toMatchObject({
			header: "Fruits",
			multiSelect: true,
			allowOther: true,
		});
		expect(p.questions[0]?.options[0]).toEqual({
			label: "Apple",
			description: "red",
		});
	});

	test("answers go back as updatedInput.answers, multi-select joined with ', '", () => {
		const p = classifyClaude("AskUserQuestion", QUESTIONS)!;
		const d = decideClaude(p, QUESTIONS, {
			kind: "question",
			answers: { "Which fruits?": ["Apple", "Plum"], "What size?": ["Medium"] },
		});
		expect(d).toEqual({
			behavior: "allow",
			updatedInput: {
				...QUESTIONS,
				answers: { "Which fruits?": "Apple, Plum", "What size?": "Medium" },
			},
		});
		expect(decideClaude(p, QUESTIONS, { kind: "cancel" }).behavior).toBe(
			"deny",
		);
	});

	test("ExitPlanMode: approve echoes the input; keep planning denies with the feedback", () => {
		const input = { plan: "# Plan\n1. do it", planFilePath: "/p.md" };
		const p = classifyClaude("ExitPlanMode", input)!;
		expect(p).toMatchObject({
			kind: "plan",
			plan: input.plan,
			planFile: "/p.md",
		});
		expect(decideClaude(p, input, { kind: "plan", choice: "approve" })).toEqual(
			{
				behavior: "allow",
				updatedInput: input,
			},
		);
		const keep = decideClaude(p, input, {
			kind: "plan",
			choice: "keep-planning",
			feedback: "add tests",
		});
		expect(keep.behavior).toBe("deny");
		expect(keep.behavior === "deny" && keep.message).toContain("add tests");
	});

	test("other tools stay permission prompts", () => {
		expect(classifyClaude("Bash", { command: "ls" })).toBeNull();
	});
});

describe("prompt and answer checks", () => {
	const q = cleanPrompt({
		kind: "question",
		questions: QUESTIONS.questions.map((x) => ({ ...x, id: x.question })),
	})!;

	test("an answer must pick from the options unless free text is allowed", () => {
		const strict = cleanPrompt({
			kind: "question",
			questions: [{ question: "Pick", options: ["A", "B"], allowOther: false }],
		})!;
		expect(() =>
			cleanAnswer({ kind: "question", answers: { Pick: ["C"] } }, strict),
		).toThrow();
		expect(
			cleanAnswer({ kind: "question", answers: { Pick: "A" } }, strict),
		).toEqual({ kind: "question", answers: { Pick: ["A"] } });
	});

	test("single-select takes one answer and every question needs one", () => {
		expect(() =>
			cleanAnswer(
				{
					kind: "question",
					answers: {
						"Which fruits?": ["Apple"],
						"What size?": ["Small", "Large"],
					},
				},
				q,
			),
		).toThrow();
		expect(() =>
			cleanAnswer(
				{ kind: "question", answers: { "Which fruits?": ["Apple"] } },
				q,
			),
		).toThrow();
	});

	test("a prompt with two questions of one id is refused", () => {
		expect(
			cleanPrompt({
				kind: "question",
				questions: [{ question: "Same" }, { question: "Same" }],
			}),
		).toBeNull();
	});

	test("the answer hash changes with the answer", () => {
		expect(answerHash({ kind: "select", value: "a" })).not.toBe(
			answerHash({ kind: "select", value: "b" }),
		);
	});
});

describe("interactions through the hook", () => {
	test("AskUserQuestion: needs-you, signed answer, hook gets updatedInput.answers", async () => {
		const { service, agent } = setup();
		const auth = await enroll(service);
		const a = hookAsk(service, agent.id, askReq("AskUserQuestion", QUESTIONS));
		expect(service.registry.needsYou(agent.id)?.detail).toBe("Answer: Fruits");
		const item = service.app.views.attention().items[0]!;
		expect(item.approval?.kind).toBe("question");
		expect(item.approval?.prompt?.kind).toBe("question");
		// A permission decision does not fit a question.
		expect(
			await code(service.approvals.options(user, rp, a.id, "allow-once")),
		).toBe("bad_request");
		const r = await answer(service, auth, a.id, {
			kind: "question",
			answers: { "Which fruits?": ["Pear"], "What size?": ["Large"] },
		});
		expect(r.won).toBe(true);
		expect(r.approval.state).toBe("allowed");
		expect(r.approval.outcome).toMatch(
			/^Answered: Pear · Large by .+ · Face ID on iOS \(phone\)/,
		);
		expect(r.approval.answer).toEqual({
			kind: "question",
			answers: { "Which fruits?": ["Pear"], "What size?": ["Large"] },
		});
		expect(await a.decision).toEqual({
			behavior: "allow",
			updatedInput: {
				...QUESTIONS,
				answers: { "Which fruits?": "Pear", "What size?": "Large" },
			},
		});
		expect(service.registry.needsYou(agent.id)).toBeNull();
	});

	test("a signature over one answer does not carry another", async () => {
		const { service, agent } = setup();
		const auth = await enroll(service);
		const a = hookAsk(service, agent.id, askReq("AskUserQuestion", QUESTIONS));
		const signedFor: InteractionAnswer = {
			kind: "question",
			answers: { "Which fruits?": ["Pear"], "What size?": ["Large"] },
		};
		const options = await service.approvals.options(user, rp, a.id, "answer", {
			answer: signedFor,
		});
		const assertion = auth.assert(
			(options as { options: { challenge: string } }).options,
		);
		expect(
			await code(
				service.approvals.decide(user, rp, a.id, {
					decision: "answer",
					answer: {
						...signedFor,
						answers: { ...signedFor.answers, "What size?": ["Small"] },
					},
					assertion,
				}),
			),
		).not.toBeNull();
		expect(service.approvals.get(a.id)?.state).toBe("pending");
	});

	test("plan: keep planning with feedback denies; the outcome names the choice", async () => {
		const { service, agent } = setup();
		const auth = await enroll(service);
		const input = { plan: "1. a\n2. b", planFilePath: "/p.md" };
		const a = hookAsk(service, agent.id, askReq("ExitPlanMode", input));
		expect(service.registry.needsYou(agent.id)?.detail).toBe("Review plan");
		const r = await answer(service, auth, a.id, {
			kind: "plan",
			choice: "keep-planning",
			feedback: "add a test step",
		});
		expect(r.approval.state).toBe("denied");
		expect(r.approval.outcome).toMatch(/^Keep planning by /);
		const d = await a.decision;
		expect(d?.behavior).toBe("deny");
		expect(d?.behavior === "deny" && d.message).toContain("add a test step");
	});

	test("first answer wins: the terminal answered, a later app answer loses", async () => {
		const { service, agent } = setup();
		const auth = await enroll(service);
		const a = hookAsk(service, agent.id, askReq("ExitPlanMode", { plan: "x" }));
		a.close();
		expect(await a.decision).toBeNull();
		expect(service.approvals.get(a.id)?.state).toBe("answered-locally");
		const options = code(
			service.approvals.options(user, rp, a.id, "answer", {
				answer: { kind: "plan", choice: "approve" },
			}),
		);
		expect(await options).toBe("decided");
		void auth;
	});
});

describe("interactions from the extension", () => {
	const select: InteractionRequest = {
		ref: "r1",
		kind: "select",
		tool: "ui.select",
		input: {},
		prompt: {
			kind: "select",
			title: "Deploy where?",
			options: [{ label: "staging" }, { label: "prod" }],
		},
		sessionRules: null,
		timeoutMs: null,
	};

	test("a select resolves with the app's answer", async () => {
		const { service, agent } = setup("omp");
		const auth = await enroll(service);
		const c = conn(agent.id);
		const result = service.approvals.ask(c.caller, select);
		const id = service.approvals.pendingFor(agent.id)[0]!.requestId;
		expect(service.registry.needsYou(agent.id)?.detail).toBe(
			"Answer: Deploy where?",
		);
		expect(
			await code(
				service.approvals.options(user, rp, id, "answer", {
					answer: { kind: "select", value: "nowhere" },
				}),
			),
		).toBe("bad_request");
		await answer(service, auth, id, { kind: "select", value: "staging" });
		expect(await result).toEqual({
			decision: "answer",
			answer: { kind: "select", value: "staging" },
			note: null,
		});
	});

	test("the local dialog answering first ends it as answered-locally", async () => {
		const { service, agent } = setup("omp");
		await enroll(service);
		const c = conn(agent.id);
		const result = service.approvals.ask(c.caller, { ...select, ref: "r2" });
		expect(service.approvals.answeredLocally(c.caller, "r2")).toBe(true);
		expect(await result).toBeNull();
		expect(service.approvals.pendingFor(agent.id)).toEqual([]);
		expect(service.registry.needsYou(agent.id)).toBeNull();
	});

	test("an extension permission offers allow-for-session with its own labels", async () => {
		const { service, agent } = setup("omp");
		const auth = await enroll(service);
		const c = conn(agent.id);
		const result = service.approvals.ask(c.caller, {
			ref: "r3",
			kind: "permission",
			tool: "bash",
			input: { command: "rm -rf build" },
			prompt: null,
			sessionRules: ["bash: rm -rf build"],
			timeoutMs: null,
		});
		const ap = service.approvals.pendingFor(agent.id)[0]!;
		expect(ap.kind).toBe("permission");
		expect(ap.sessionRules).toEqual(["bash: rm -rf build"]);
		const options = await service.approvals.options(
			user,
			rp,
			ap.requestId,
			"allow-session",
		);
		const assertion = auth.assert(
			(options as { options: { challenge: string } }).options,
		);
		await service.approvals.decide(user, rp, ap.requestId, {
			decision: "allow-session",
			assertion,
		});
		expect(await result).toEqual({
			decision: "allow-session",
			answer: null,
			note: null,
		});
	});

	test("a ref can't be asked twice while pending", async () => {
		const { service, agent } = setup("omp");
		await enroll(service);
		const c = conn(agent.id);
		void service.approvals.ask(c.caller, { ...select, ref: "dup" });
		expect(
			await code(() =>
				service.approvals.ask(c.caller, { ...select, ref: "dup" }),
			),
		).toBe("bad_request");
	});
});

describe("review follow-ups", () => {
	test("an extension prompt's hash covers the prompt, so a signature can't move to another plan", async () => {
		const { service, agent } = setup("omp");
		await enroll(service);
		const c = conn(agent.id);
		const plan = (text: string, ref: string): InteractionRequest => ({
			ref,
			kind: "plan",
			tool: "plan_review",
			input: {},
			prompt: {
				kind: "plan",
				plan: text,
				choices: [{ id: "execute", label: "Execute", approves: true }],
			},
			sessionRules: null,
			timeoutMs: null,
		});
		void service.approvals.ask(c.caller, plan("rm -rf /", "a"));
		void service.approvals.ask(c.caller, plan("echo hi", "b"));
		const [a, b] = service.approvals.pendingFor(agent.id);
		expect(a!.inputHash).not.toBe(b!.inputHash);
	});

	test("a secret answer reaches the agent but is stored and shown redacted", async () => {
		const { service, agent } = setup("omp");
		const auth = await enroll(service);
		const c = conn(agent.id);
		const result = service.approvals.ask(c.caller, {
			ref: "pw",
			kind: "input",
			tool: "ui.input",
			input: {},
			prompt: { kind: "input", title: "Password", secret: true },
			sessionRules: null,
			timeoutMs: null,
		});
		const id = service.approvals.pendingFor(agent.id)[0]!.requestId;
		const r = await answer(service, auth, id, {
			kind: "input",
			value: "hunter2",
		});
		expect(JSON.stringify(r.approval)).not.toContain("hunter2");
		expect((await result)?.answer).toEqual({ kind: "input", value: "hunter2" });
	});

	test("a form's secret question is redacted in every stored and shared copy; plain answers stay", async () => {
		const { service, agent } = setup("omp");
		const auth = await enroll(service);
		const c = conn(agent.id);
		const events: unknown[] = [];
		const off = service.events.on("approval", (e) => events.push(e));
		const result = service.approvals.ask(c.caller, {
			ref: "form",
			kind: "question",
			tool: "ask",
			input: {},
			prompt: {
				kind: "question",
				questions: [
					{
						id: "user",
						question: "User name?",
						multiSelect: false,
						options: [],
						allowOther: true,
					},
					{
						id: "token",
						question: "API token?",
						multiSelect: false,
						options: [],
						allowOther: true,
						secret: true,
					},
				],
			},
			sessionRules: null,
			timeoutMs: null,
		});
		const id = service.approvals.pendingFor(agent.id)[0]!.requestId;
		const real = {
			kind: "question" as const,
			answers: { user: ["ada"], token: ["hunter2"] },
		};
		const r = await answer(service, auth, id, real);
		off();
		const redacted = {
			kind: "question" as const,
			answers: { user: ["ada"], token: [SECRET] },
		};
		// The app's copy (the decide response and a later read).
		expect(r.approval.answer).toEqual(redacted);
		expect(service.approvals.get(id)?.answer).toEqual(redacted);
		// The pool's copy (what this node shares with other nodes).
		const pool = service.approvals.recentFor(agent.id, 60_000);
		expect(pool.find((a) => a.requestId === id)?.answer).toEqual(redacted);
		// Stored: the row, the audit log, and the events every tab gets.
		const row = service.store.db
			.prepare("SELECT * FROM approvals WHERE id = ?")
			.get(id);
		const audit = service.store.db.prepare("SELECT * FROM audit").all();
		for (const copy of [r.approval, pool, row, audit, events])
			expect(JSON.stringify(copy)).not.toContain("hunter2");
		expect(JSON.stringify(row)).toContain("ada");
		// The agent still gets the real value.
		expect((await result)?.answer).toEqual(real);
	});

	test("Claude EnterPlanMode is a confirm; yes echoes the input", () => {
		const p = classifyClaude("EnterPlanMode", {})!;
		expect(p.kind).toBe("confirm");
		expect(decideClaude(p, {}, { kind: "confirm", confirmed: true })).toEqual({
			behavior: "allow",
			updatedInput: {},
		});
		expect(
			decideClaude(p, {}, { kind: "confirm", confirmed: false }).behavior,
		).toBe("deny");
	});
});
