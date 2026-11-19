import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pulsarExtension, { hostSessionName } from "../src/extension.ts";
import { LocalFeed } from "../src/federation/local.ts";
import { CodexNameIndex, codexNames } from "../src/harnesses/codex-names.ts";
import {
	harnessNameOf,
	nameFromHarness,
	pulsarNameFor,
} from "../src/harnesses/names.ts";
import { OPS } from "../src/service/authorize.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { FORMER_NAME_MS, type UpsertInput } from "../src/service/registry.ts";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/types.ts";
import { registration, startDaemon, until } from "./helpers.ts";

const dirs: string[] = [];
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), "pulsar-names-"));
	dirs.push(d);
	return d;
};

afterEach(() => {
	setSystemTime();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("nameFromHarness", () => {
	test.each([
		// omp's generated titles: emoji and category go.
		[
			"🐝 SWARM: Swarm-review first program and harness",
			"auto",
			"swarm-review-first-program-and-harness",
		],
		[
			"🔍 SRCH: Fix omp web search Ollama dependency",
			"auto",
			"fix-omp-web-search-ollama-dependency",
		],
		// A rename keeps its prefix: the user typed it.
		["API: gateway", "user", "api-gateway"],
		// Codex thread names and user renames.
		["Recover TODO and audit game", "user", "recover-todo-and-audit-game"],
		["pulsar-remote", "user", "pulsar-remote"],
		["My Reviewer", "user", "my-reviewer"],
		// Short names keep their last word, whatever it is.
		["Sign in", "user", "sign-in"],
		["single sign on", "auto", "single-sign-on"],
		// A long title is cut at a word boundary, never on a dangling word.
		[
			"Investigate the flaky federation test and the outbox retry path",
			"auto",
			"investigate-the-flaky-federation-test",
		],
		// A category with nothing after it is the name.
		["DOCS:", "auto", "docs"],
	] as const)("%s (%s) -> %s", (raw, source, want) => {
		expect(nameFromHarness(raw, source)).toBe(want);
	});

	test("Claude names are taken as before: slugged, not cut, a non-ASCII one as it is", () => {
		const long = "a-very-long-claude-session-name-that-runs-past-forty";
		expect(pulsarNameFor({ claudeName: long })).toBe(long);
		expect(pulsarNameFor({ claudeName: "My Agent" })).toBe("my-agent");
		expect(pulsarNameFor({ claudeName: "日本" })).toBe("日本");
		expect(pulsarNameFor({ claudeName: "API: x" })).toBe("api-x");
	});

	test.each([
		"New session - 2026-11-18T10:00:00.000Z",
		"Child session",
		"🐝🐝",
		"   ",
	])("no name from %p", (raw) => {
		expect(nameFromHarness(raw)).toBeNull();
	});

	test("meta: harnessName first, Claude's key still counts, source defaults to user", () => {
		expect(harnessNameOf({ claudeName: "a" })).toEqual({
			raw: "a",
			source: "user",
		});
		expect(
			harnessNameOf({
				claudeName: "a",
				harnessName: "b",
				harnessNameSource: "auto",
			}),
		).toEqual({ raw: "b", source: "auto" });
		expect(harnessNameOf({})).toBeNull();
	});
});

describe("registry naming", () => {
	const service = (store = new Store(":memory:")) => {
		const svc = new PulsarService({ store, scan: false, machine: "t" });
		return { svc, store, reg: svc.registry };
	};
	const input = (over: Partial<UpsertInput> = {}): UpsertInput => ({
		harness: "omp",
		// Session ids, not pids: a pid that is not alive reads as gone.
		sessionId: "s1",
		pid: null,
		cwd: "/x/bug-bounties",
		project: "bug-bounties",
		branch: "main",
		tags: [],
		meta: {},
		registered: true,
		...over,
	});
	const sender = (reg: PulsarService["registry"]) =>
		reg.upsert(input({ harness: "claude", sessionId: "sender", pid: null }));

	test("no harness name: <harness>@<project>", () => {
		const { svc, store, reg } = service();
		try {
			expect(reg.upsert(input()).name).toBe("omp@bug-bounties");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a harness name at registration names the agent", () => {
		const { svc, store, reg } = service();
		try {
			const a = reg.upsert(
				input({
					meta: {
						harnessName: "🐝 SWARM: Swarm-review first program",
						harnessNameSource: "auto",
					},
				}),
			);
			expect(a.name).toBe("swarm-review-first-program");
			expect(a.meta.nameFrom).toBe("harness");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a name that arrives later renames the agent, announces it, and the old name still resolves for a while", () => {
		const { svc, store, reg } = service();
		try {
			const me = sender(reg);
			const a = reg.upsert(input());
			const updates: string[] = [];
			svc.events.on("agent", (e) => {
				if (e.action === "update" && e.agent.id === a.id)
					updates.push(e.agent.name);
			});
			reg.applyHarnessName(a, "Audit target selection", "auto");
			expect(a.name).toBe("audit-target-selection");
			expect(updates).toEqual(["audit-target-selection"]);
			// Same name again: nothing happens.
			reg.applyHarnessName(a, "Audit target selection", "auto");
			expect(updates).toHaveLength(1);
			// Old and new names both reach it; the id always does.
			expect(
				reg.resolveTargets("omp@bug-bounties", me).map((t) => t.id),
			).toEqual([a.id]);
			expect(
				reg.resolveTargets("audit-target-selection", me).map((t) => t.id),
			).toEqual([a.id]);
			expect(reg.resolveTargets(a.id, me).map((t) => t.id)).toEqual([a.id]);
			// Re-registering (the MCP server's hello, no name in it) keeps the name.
			expect(reg.upsert(input()).name).toBe("audit-target-selection");
			// After the grace period the old name is free and resolves to nobody.
			setSystemTime(new Date(Date.now() + FORMER_NAME_MS + 1000));
			expect(reg.resolveTargets("omp@bug-bounties", me)).toEqual([]);
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a live agent that holds a former name wins over the alias", () => {
		const { svc, store, reg } = service();
		try {
			const me = sender(reg);
			const a = reg.upsert(input());
			reg.applyHarnessName(a, "renamed", "user");
			const b = reg.upsert(
				input({ sessionId: "s2", name: "omp@bug-bounties" }),
			);
			expect(
				reg.resolveTargets("omp@bug-bounties", me).map((t) => t.id),
			).toEqual([b.id]);
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("an old name goes to the renamed agent, not to another agent it is a prefix of", () => {
		const { svc, store, reg } = service();
		try {
			const me = sender(reg);
			const a = reg.upsert(input());
			const b = reg.upsert(input({ sessionId: "s2" }));
			expect(b.name).toBe("omp@bug-bounties-2");
			reg.applyHarnessName(a, "Renamed", "user");
			expect(
				reg.resolveTargets("omp@bug-bounties", me).map((t) => t.id),
			).toEqual([a.id]);
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a session that loses its name (/new) goes back to the default, the old name an alias", () => {
		const { svc, store, reg } = service();
		try {
			const me = sender(reg);
			const a = reg.upsert(input());
			reg.applyHarnessName(a, "Named", "user");
			expect(a.name).toBe("named");
			reg.applyHarnessName(a, "", "user");
			expect(a.name).toBe("omp@bug-bounties");
			expect(a.meta.harnessName).toBeUndefined();
			expect(reg.resolveTargets("named", me).map((t) => t.id)).toEqual([a.id]);
			// A chosen name never goes back.
			reg.setIdentity(a, { name: "mine" });
			reg.applyHarnessName(a, "Again", "user");
			reg.applyHarnessName(a, "", "user");
			expect(a.name).toBe("mine");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("collisions get a stable suffix; a rename moves only the renamed agent", () => {
		const { svc, store, reg } = service();
		try {
			const meta = { harnessName: "Fix login", harnessNameSource: "user" };
			const a = reg.upsert(input({ meta }));
			const b = reg.upsert(input({ sessionId: "s2", meta }));
			expect([a.name, b.name]).toEqual(["fix-login", "fix-login-2"]);
			// Scans and hellos repeat the same name: the suffix stays.
			expect(reg.upsert(input({ sessionId: "s2", meta })).name).toBe(
				"fix-login-2",
			);
			reg.applyHarnessName(reg.get(b.id) as Agent, "Fix logout", "user");
			expect(reg.get(b.id)?.name).toBe("fix-logout");
			expect(reg.get(a.id)?.name).toBe("fix-login");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a scanned harness rename (Claude /rename, OpenCode title) follows live", () => {
		const { svc, store, reg } = service();
		try {
			const claude = (name: string) =>
				reg.upsert(
					input({
						harness: "claude",
						sessionId: "s1",
						pid: null,
						registered: false,
						meta: { claudeName: name, harnessNameSource: "user" },
					}),
				);
			expect(claude("first").name).toBe("first");
			expect(claude("second").name).toBe("second");
			const oc = (title: string) =>
				reg.upsert(
					input({
						harness: "opencode",
						sessionId: "ses_1",
						pid: null,
						registered: false,
						meta: { harnessName: title, harnessNameSource: "auto" },
					}),
				);
			// A placeholder title is no name.
			expect(oc("New session - 2026-11-18T10:00:00.000Z").name).toBe(
				"opencode@bug-bounties",
			);
			expect(oc("Refactor billing").name).toBe("refactor-billing");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a name the agent chose beats the harness name, also after a restart", () => {
		const file = join(tempDir(), "p.db");
		let { svc, store, reg } = service(new Store(file));
		const a = reg.upsert(input({ meta: { harnessName: "harness given" } }));
		reg.setIdentity(a, { name: "chosen" });
		reg.applyHarnessName(a, "harness renamed", "user");
		expect(a.name).toBe("chosen");
		svc.stop();
		store.close();
		({ svc, store, reg } = service(new Store(file)));
		try {
			expect(
				reg.upsert(input({ meta: { harnessName: "harness given" } })).name,
			).toBe("chosen");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("set_identity without a name does not pin the name: after a restart the harness name still wins", () => {
		const file = join(tempDir(), "p.db");
		let { svc, store, reg } = service(new Store(file));
		const a = reg.upsert(input());
		reg.setIdentity(a, { activity: "working", model: "m" });
		svc.stop();
		store.close();
		({ svc, store, reg } = service(new Store(file)));
		try {
			const b = reg.upsert(input());
			expect(b.activity).toBe("working");
			reg.applyHarnessName(b, "Late title", "auto");
			expect(b.name).toBe("late-title");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("names older daemons saved: a default or the harness name does not pin; a chosen one does", () => {
		const file = join(tempDir(), "p.db");
		const store = new Store(file);
		const save = (id: string, name: string) =>
			store.saveIdentity(
				id,
				{ name, tags: [], activity: null, inbound: "accept" },
				Date.now(),
			);
		save("omp:s-1", "omp@bug-bounties");
		save("claude:c1", "claude-title");
		save("omp:s-3", "picked");
		const { svc, reg } = service(store);
		try {
			const one = reg.upsert(input({ sessionId: "s-1" }));
			reg.applyHarnessName(one, "Real name", "auto");
			expect(one.name).toBe("real-name");
			const claude = reg.upsert(
				input({
					harness: "claude",
					sessionId: "c1",
					pid: null,
					meta: { claudeName: "claude-title" },
				}),
			);
			expect(claude.meta.nameFrom).toBe("harness");
			const three = reg.upsert(input({ sessionId: "s-3" }));
			reg.applyHarnessName(three, "Ignored", "auto");
			expect(three.name).toBe("picked");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("federation carries a rename to peers as a delta (same id, new name)", () => {
		const { svc, store, reg } = service();
		try {
			const feed = new LocalFeed(svc);
			const a = reg.upsert(input());
			feed.tick();
			reg.applyHarnessName(a, "Fed name", "user");
			const delta = feed.tick();
			expect(delta?.upserts.map((u) => [u.id, u.name])).toEqual([
				[a.id, "fed-name"],
			]);
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("a connection that moves to its Codex thread id takes the thread's name, not the old default", () => {
		const { svc, store, reg } = service();
		try {
			const caller: Caller = {
				principal: { kind: "terminal" },
				closed: new AbortController().signal,
				emit: () => {},
			};
			svc.attach(caller);
			svc.setRole(caller, "mcp");
			const codex = { harness: "codex", role: "mcp" as const };
			const first = svc.registerAgent(
				caller,
				registration({ ...codex, sessionId: null, pid: process.pid }),
			);
			expect(first.name).toBe("codex@apparish");
			const moved = svc.registerAgent(
				caller,
				registration({ ...codex, sessionId: "t-1", pid: process.pid }),
			);
			reg.applyHarnessName(moved, "Recover TODO", "user");
			expect(reg.get(moved.id)?.name).toBe("recover-todo");
			// A self-chosen name moves with the connection and sticks.
			reg.setIdentity(moved, { name: "picked" });
			const again = svc.registerAgent(
				caller,
				registration({ ...codex, sessionId: "t-2", pid: process.pid }),
			);
			expect(again.name).toBe("picked");
			reg.applyHarnessName(again, "Other", "user");
			expect(again.name).toBe("picked");
			// A thread id with a saved chosen name keeps it over the old one.
			store.saveIdentity(
				"codex:t-3",
				{ name: "saved-pick", tags: [], activity: null, inbound: "accept" },
				Date.now(),
			);
			const third = svc.registerAgent(
				caller,
				registration({ ...codex, sessionId: "t-3", pid: process.pid }),
			);
			expect(third.name).toBe("saved-pick");
		} finally {
			svc.stop();
			store.close();
		}
	});

	test("harness_name is an agent-only socket op", () => {
		expect(OPS).toContain("harness_name");
	});
});

describe("Codex thread names", () => {
	test("reads the index incrementally: last line wins, torn lines wait, a rewrite starts over", async () => {
		const file = join(tempDir(), "session_index.jsonl");
		const index = new CodexNameIndex(() => file);
		const line = (id: string, name: string) =>
			`${JSON.stringify({ id, thread_name: name, updated_at: "2026-11-18" })}\n`;
		await index.refresh(); // no file yet
		expect(index.get("t1")).toBeUndefined();
		writeFileSync(file, line("t1", "First") + line("t2", "Other"));
		await index.refresh();
		expect(index.get("t1")).toBe("First");
		// A rename is a new line; half a line waits for the rest.
		const next = line("t1", "Renamed");
		appendFileSync(file, next.slice(0, 10));
		await index.refresh();
		expect(index.get("t1")).toBe("First");
		appendFileSync(file, `${next.slice(10)}not json\n`);
		await index.refresh();
		expect(index.get("t1")).toBe("Renamed");
		// Rewritten smaller: read again from the start.
		writeFileSync(file, line("t3", "Third"));
		await index.refresh();
		expect(index.get("t3")).toBe("Third");
		expect(index.get("t1")).toBeUndefined();
	});

	test("codexNames reports names for agents with a thread, as the user's", async () => {
		const file = join(tempDir(), "session_index.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ id: "t1", thread_name: "Recover TODO" })}\n`,
		);
		const agent = (sessionId: string | null) =>
			({ id: `codex:${sessionId}`, sessionId }) as Agent;
		const got = await codexNames(
			[agent("t1"), agent("t2"), agent(null)],
			new CodexNameIndex(() => file),
		);
		expect(got.map((g) => [g.agent.sessionId, g.name, g.source])).toEqual([
			["t1", "Recover TODO", "user"],
		]);
	});
});

describe("pi/omp extension names", () => {
	test("hostSessionName: omp's header source, omp without one is generated, pi's is the user's", () => {
		const ctx = (name?: string, titleSource?: string) => ({
			sessionManager: {
				getSessionName: () => name,
				getHeader: () => ({ titleSource }),
			},
		});
		expect(hostSessionName("omp", ctx("A", "user"), {})).toEqual({
			name: "A",
			source: "user",
		});
		expect(hostSessionName("omp", ctx("A"), {})).toEqual({
			name: "A",
			source: "auto",
		});
		expect(hostSessionName("pi", ctx("A"), {})).toEqual({
			name: "A",
			source: "user",
		});
		// The API's getSessionName when the context has none.
		expect(hostSessionName("pi", {}, { getSessionName: () => "B" })).toEqual({
			name: "B",
			source: "user",
		});
		expect(hostSessionName("pi", ctx(undefined), {})).toEqual({
			name: "",
			source: "user",
		});
		const stale = {
			sessionManager: {
				getSessionName: () => {
					throw new Error("stale");
				},
			},
		};
		expect(hostSessionName("omp", stale, {})).toBeNull();
	});

	test("the extension names its agent on hello and follows a rename without a restart", async () => {
		const { daemon, cleanup } = await startDaemon();
		// biome-ignore lint/suspicious/noExplicitAny: a fake host context
		const handlers = new Map<string, ((e: unknown, c: any) => unknown)[]>();
		let name: string | undefined = "🔍 AUDIT: Audit target selection";
		const ctx = {
			isIdle: () => true,
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionName: () => name,
				getHeader: () => ({ titleSource: "auto" }),
			},
		};
		pulsarExtension({
			on: (event, fn) => {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			},
			sendMessage: () => {},
		});
		const fire = async (event: string) => {
			for (const fn of handlers.get(event) ?? []) await fn({}, ctx);
		};
		const me = () =>
			daemon.service.registry.live().find((a) => a.pid === process.pid);
		try {
			await fire("session_start");
			await until(() => me()?.name === "audit-target-selection");
			name = "My audit";
			await fire("turn_end");
			await until(() => me()?.name === "my-audit");
			expect(me()?.meta.harnessNameSource).toBe("auto");
			// `/new`: the next session has no name yet; the old one goes.
			name = undefined;
			await fire("session_start");
			await until(() => me()?.meta.harnessName === undefined);
			expect(me()?.name).not.toBe("my-audit");
		} finally {
			await fire("session_shutdown");
			for (const fn of handlers.get("session_shutdown") ?? [])
				await fn({ reason: "quit" }, ctx);
			await daemon.stop();
			cleanup();
		}
	});
});
