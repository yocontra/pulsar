/**
 * The app's time to answer follows the hook's real timeout (`--timeout`,
 * written by `pulsar setup`), and a prompt left to the terminal after it
 * ran out is shown read-only with the prompt it was.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { giveUpMs, hookTimeoutArg } from "../src/hook.ts";
import {
	APPROVAL_TIMEOUT_MS,
	type ApprovalRequest,
	approvalDeadlineMs,
} from "../src/service/approvals.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function setup(
	opts: ConstructorParameters<typeof PulsarService>[0]["approvals"] = {},
	pid: number | null = null,
) {
	const store = new Store(":memory:");
	const service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null, answerable: () => true, ...opts },
	});
	cleanups.push(() => {
		service.stop();
		store.close();
	});
	const agent = service.registry.upsert({
		harness: "claude",
		sessionId: "sess-1",
		pid,
		cwd: "/repo",
		project: "repo",
		branch: "main",
		tags: [],
		meta: {},
		registered: true,
	});
	return { service, store, agent };
}

const BASH: ApprovalRequest = {
	sessionId: "sess-1",
	promptId: "turn-1",
	tool: "Bash",
	input: { command: "git init -q", description: "init" },
	suggestions: [],
	cwd: "/repo",
	transcriptPath: null,
};

function ask(service: PulsarService, agentId: string, req: ApprovalRequest) {
	const ac = new AbortController();
	const caller: Caller = {
		principal: { kind: "agent", agentId },
		closed: ac.signal,
		emit() {},
	};
	const decision = service.approvals.request(caller, req);
	const ap = service.approvals.pendingFor(agentId).at(-1)!;
	cleanups.push(() => ac.abort());
	return { decision, ap, close: () => ac.abort() };
}

describe("the app's deadline follows the hook's timeout", () => {
	test("a minute under Claude's hook timeout, however long it is", () => {
		expect(approvalDeadlineMs(3600, APPROVAL_TIMEOUT_MS)).toBe(3_540_000);
		expect(approvalDeadlineMs(600, APPROVAL_TIMEOUT_MS)).toBe(540_000);
		// Short timeouts keep a tenth in hand.
		expect(approvalDeadlineMs(60, APPROVAL_TIMEOUT_MS)).toBe(54_000);
		// A day (what setup installs): no hour cap.
		expect(approvalDeadlineMs(86_400, APPROVAL_TIMEOUT_MS)).toBe(86_340_000);
		// Past what a Node timer holds: the longest one.
		expect(approvalDeadlineMs(30 * 86_400, APPROVAL_TIMEOUT_MS)).toBe(
			2 ** 31 - 1,
		);
		// A hook that doesn't say: the old 540 s.
		expect(approvalDeadlineMs(null, APPROVAL_TIMEOUT_MS)).toBe(540_000);
	});

	test("the hook reads its timeout from its own command line", () => {
		expect(hookTimeoutArg(["--timeout", "3600"])).toBe(3600);
		expect(hookTimeoutArg([])).toBeNull();
		expect(hookTimeoutArg(["--timeout", "soon"])).toBeNull();
		expect(hookTimeoutArg(["--timeout", "-5"])).toBeNull();
	});

	test("the hook gives up 20 s before Claude kills it; an hour when it doesn't say", () => {
		expect(giveUpMs(86_400)).toBe(86_380_000);
		expect(giveUpMs(3600)).toBe(3_580_000);
		expect(giveUpMs(null)).toBe(3_580_000);
		expect(giveUpMs(10)).toBe(1000);
		expect(giveUpMs(30 * 86_400)).toBe(2 ** 31 - 1);
	});

	test("asked again after a restart: the deadline keeps the time already spent", () => {
		const { service, agent } = setup();
		const again = ask(service, agent.id, {
			...BASH,
			hookTimeoutS: 3600,
			elapsedMs: 600_000,
		});
		expect(again.ap.expiresAt - again.ap.createdAt).toBe(2_940_000);
		// A day's hook asked again an hour in.
		const day = ask(service, agent.id, {
			...BASH,
			promptId: "turn-2",
			hookTimeoutS: 86_400,
			elapsedMs: 3_600_000,
		});
		expect(day.ap.expiresAt - day.ap.createdAt).toBe(82_740_000);
	});

	test("asked again with under 5 s left: no card, the terminal decides", async () => {
		const { service, agent } = setup();
		const before = service.approvals.pendingFor(agent.id).length;
		const caller: Caller = {
			principal: { kind: "agent", agentId: agent.id },
			closed: new AbortController().signal,
			emit() {},
		};
		const decision = await service.approvals.request(caller, {
			...BASH,
			hookTimeoutS: 600,
			elapsedMs: 537_000,
		});
		expect(decision).toBeNull();
		expect(service.approvals.pendingFor(agent.id).length).toBe(before);
	});

	test("a stopping daemon ends a hook's prompt as restarted, not expired", async () => {
		const { service, agent } = setup();
		const a = ask(service, agent.id, { ...BASH, hookTimeoutS: 3600 });
		service.approvals.stop();
		expect(await a.decision).toBeNull();
		expect(service.approvals.stopping).toBe(true);
		const ended = service.approvals.get(a.ap.requestId)!;
		expect(ended.state).toBe("expired");
		expect(ended.outcome).toMatch(/^Closed: Pulsar restarted · /);
		// A terminal wait right after is not blamed on the app's time running out.
		expect(service.approvals.expiredBefore(agent, Date.now())).toBeNull();
	});

	test("a permission prompt's expiry: the hook's hour, the old 540 s without one", () => {
		const { service, agent } = setup();
		const hour = ask(service, agent.id, { ...BASH, hookTimeoutS: 3600 });
		expect(hour.ap.expiresAt - hour.ap.createdAt).toBe(3_540_000);
		const old = ask(service, agent.id, { ...BASH, promptId: "turn-2" });
		expect(old.ap.expiresAt - old.ap.createdAt).toBe(APPROVAL_TIMEOUT_MS);
		const ten = ask(service, agent.id, {
			...BASH,
			promptId: "turn-3",
			hookTimeoutS: 600,
		});
		expect(ten.ap.expiresAt - ten.ap.createdAt).toBe(540_000);
	});

	test("sessions on a hook without --timeout are listed for doctor until they ask with one", () => {
		const { service, agent } = setup({}, process.pid);
		ask(service, agent.id, BASH);
		expect(service.approvals.oldHookSessions()).toEqual([
			{ name: agent.name, pid: process.pid },
		]);
		ask(service, agent.id, { ...BASH, promptId: "t2", hookTimeoutS: 3600 });
		expect(service.approvals.oldHookSessions()).toEqual([]);
	});
});

describe("a terminal wait after the app's time ran out", () => {
	const TERMINAL = {
		reason: "terminal" as const,
		detail: "Waiting in the terminal: permission prompt",
	};

	test("shows the expired prompt, read-only, with why", async () => {
		const { service, agent } = setup({ timeoutMs: 20 });
		const a = ask(service, agent.id, BASH);
		expect(await a.decision).toBeNull();
		service.registry.setNeedsYou(agent.id, TERMINAL);
		const item = service.app.views.attention().items[0]!;
		expect(item.kind).toBe("terminal");
		expect(item.approval).toBeUndefined();
		expect(item.terminal?.why).toBe("expired");
		expect(item.terminal?.approval?.input).toEqual(BASH.input);
		expect(item.terminal?.approval?.state).toBe("expired");
	});

	test("found under a sibling id of the same process", async () => {
		const { service, agent } = setup({ timeoutMs: 20 }, process.pid);
		const sibling = service.registry.upsert({
			harness: "claude",
			sessionId: "sess-0",
			pid: process.pid,
			cwd: "/repo",
			project: "repo",
			branch: "main",
			tags: [],
			meta: {},
			registered: true,
		});
		const a = ask(service, sibling.id, { ...BASH, sessionId: "sess-0" });
		expect(await a.decision).toBeNull();
		service.registry.setNeedsYou(agent.id, TERMINAL);
		const item = service.app.views
			.attention()
			.items.find((i) => i.agent.id === agent.id)!;
		expect(item.terminal?.why).toBe("expired");
	});

	test("not sent: no prompt, one answered in the terminal, or one long before", async () => {
		const none = setup();
		none.service.registry.setNeedsYou(none.agent.id, TERMINAL);
		expect(none.service.app.views.attention().items[0]!.terminal).toEqual({
			why: "not-sent",
		});

		const local = setup();
		const a = ask(local.service, local.agent.id, BASH);
		a.close();
		expect(await a.decision).toBeNull();
		local.service.registry.setNeedsYou(local.agent.id, TERMINAL);
		expect(local.service.app.views.attention().items[0]!.terminal?.why).toBe(
			"not-sent",
		);

		let now = Date.now();
		const late = setup({ timeoutMs: 20, now: () => now });
		const b = ask(late.service, late.agent.id, BASH);
		expect(await b.decision).toBeNull();
		// The wait began ten minutes after the prompt expired: another dialog.
		now += 600_000;
		expect(late.service.approvals.expiredBefore(late.agent, now)).toBeNull();
		expect(
			late.service.approvals.expiredBefore(late.agent, now - 600_000 + 2_000),
		).not.toBeNull();
	});
});
