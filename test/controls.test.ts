import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinsFor } from "../src/harnesses/builtins.ts";
import type { ApiResult } from "../src/harnesses/opencode-api.ts";
import type { Caller } from "../src/service/caller.ts";
import { frontmatter } from "../src/service/catalog.ts";
import {
	type ControlPorts,
	Controls,
	claudePath,
	modeFromLog,
	ownsPane,
	parseCommand,
} from "../src/service/controls.ts";
import type { Agent } from "../src/types.ts";

/**
 * Modes and slash commands (src/service/controls.ts) on fakes: a pane that
 * draws what the real TUIs draw (the shapes test/screens.test.ts reads from
 * captured fixtures), a fake Codex app-server, a fake OpenCode API and a
 * fake pulsar extension. Nothing here reaches tmux or a real agent.
 */

const dir = mkdtempSync(join(tmpdir(), "pulsar-controls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function agent(over: Partial<Agent> = {}): Agent {
	return {
		id: "claude:s1",
		name: "a",
		harness: "claude",
		sessionId: "s1",
		pid: 4242,
		cwd: join(dir, "proj"),
		project: null,
		branch: null,
		tags: [],
		status: "idle",
		model: null,
		activity: null,
		inbound: "accept",
		registered: true,
		reach: "push",
		lastSeen: 0,
		createdAt: 0,
		meta: {},
		...over,
	};
}

const RULE = "─".repeat(60);
const FOOTER: Record<string, string> = {
	default: "⏸ manual mode on · ? for shortcuts",
	acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle)",
	plan: "⏸ plan mode on (shift+tab to cycle)",
	auto: "⏵⏵ auto mode on (shift+tab to cycle)",
	bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle)",
	dontAsk: "⏵⏵ don't ask on (shift+tab to cycle)",
};

/** A pane that behaves like the harness TUI for the keys Pulsar sends. */
class FakePane {
	mode: string;
	input = "";
	dialog = false;
	submitted: string[] = [];
	keys: string[] = [];
	/** Typed text shows only after this many reads (a slow terminal). */
	lag = 0;
	private pendingText: string | null = null;
	readonly harness: "claude" | "codex" | "opencode" | "pi" | "omp";
	readonly cycle: string[];
	constructor(
		harness: "claude" | "codex" | "opencode" | "pi" | "omp",
		cycle: string[],
		mode?: string,
	) {
		this.harness = harness;
		this.cycle = cycle;
		this.mode = mode ?? cycle[0]!;
	}
	render(): string {
		if (this.pendingText !== null) {
			if (this.lag-- <= 0) {
				this.input += this.pendingText;
				this.pendingText = null;
			}
		}
		if (this.dialog)
			return "Quick safety check: trust this folder?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm\n";
		const ph = (s: string) => `\x1b[2m${s}\x1b[0m`;
		switch (this.harness) {
			case "pi":
				return `${RULE}\n${this.input}\n${RULE}\n/tmp/x\n0.0%/66k (auto)    test`;
			case "omp":
				return `π > test ▶───\n╰─ ${this.input}`;
			case "claude":
				return `${RULE}\n\x1b[39m❯ ${this.input || ph('Try "fix lint errors"')}\n${RULE}\n  ${FOOTER[this.mode] ?? "?"}\n`;
			case "codex":
				return `\x1b[1m›\x1b[0m ${this.input || ph("Ask Codex to do anything")}\n\n  GPT high · /tmp/x\n  ? for shortcuts   ${this.mode === "plan" ? "Plan mode (⇧tab to cycle)" : ""}\n`;
			case "opencode":
				return `┃\n┃  ${this.input || "\x1b[38;2;128;128;128mAsk anything…"}\n┃\n┃  ${this.mode === "plan" ? "Plan" : "Build"} · Model\n/tmp/x   shift+tab agents  ctrl+p commands\n`;
		}
	}
	press(keys: string[]) {
		for (const k of keys) {
			this.keys.push(k);
			if (k === "BTab") {
				const i = this.cycle.indexOf(this.mode);
				this.mode = this.cycle[(i + 1) % this.cycle.length]!;
			} else if (k === "Enter") {
				this.submitted.push(this.input);
				this.input = "";
			}
		}
	}
	type(text: string) {
		this.keys.push(`text:${text}`);
		if (this.lag > 0) this.pendingText = text;
		else this.input += text;
	}
}

interface Rig {
	controls: Controls;
	pane: FakePane | null;
	codexCalls: Array<[string, unknown]>;
	opencodeCalls: Array<{ method: string; path: string; body?: unknown }>;
}

function rig(opts: {
	pane?: FakePane | null;
	log?: string;
	codexReady?: boolean;
	codexThreadModel?: string;
	codexThreadEffort?: string;
	codexConfig?: Record<string, unknown>;
	opencode?: (method: string, path: string, body?: unknown) => ApiResult;
	extension?: (req: Record<string, unknown>) => Record<string, unknown> | null;
	home?: string;
	version?: string | null;
	agents?: Agent[];
}): Rig {
	const pane = opts.pane ?? null;
	const codexCalls: Rig["codexCalls"] = [];
	const opencodeCalls: Rig["opencodeCalls"] = [];
	const agents = opts.agents ?? [agent()];
	let controls: Controls;
	const ext: Pick<Caller, "emit"> | undefined = opts.extension
		? {
				emit(event: string, data: unknown) {
					if (event !== "control") return;
					const req = data as Record<string, unknown>;
					const answer = opts.extension!(req);
					if (answer)
						queueMicrotask(() =>
							controls.answer(agents[0]!.id, {
								requestId: req.requestId,
								...answer,
							}),
						);
				},
			}
		: undefined;
	const ports: Partial<ControlPorts> = {
		pane: async () => (pane ? "%7" : null),
		capture: async () => pane?.render() ?? null,
		keys: async (_p, keys) => {
			pane!.press(keys);
			return { ok: true };
		},
		text: async (_p, text) => {
			pane!.type(text);
			return { ok: true };
		},
		sleep: async () => {},
		codexReady: async () => opts.codexReady ?? false,
		codex: async (calls) => {
			codexCalls.push(...calls);
			return calls.map(([method, params]) => {
				if (method === "thread/read")
					return {
						thread: {
							id: "t",
							model: opts.codexThreadModel ?? "gpt-x",
							...(opts.codexThreadEffort
								? { reasoningEffort: opts.codexThreadEffort }
								: {}),
						},
					};
				if (method === "config/read") return { config: opts.codexConfig ?? {} };
				if (method === "collaborationMode/list")
					return {
						data: [
							{
								name: "Plan",
								mode: "plan",
								model: null,
								reasoning_effort: "medium",
							},
							{
								name: "Default",
								mode: "default",
								model: null,
								reasoning_effort: null,
							},
						],
					};
				if (method === "thread/settings/update") {
					const mode = (params as { collaborationMode: { mode: string } })
						.collaborationMode.mode;
					if (pane) pane.mode = mode;
					return {};
				}
				return {};
			});
		},
		opencode: async (method, path, body) => {
			opencodeCalls.push({
				method,
				path,
				...(body !== undefined ? { body } : {}),
			});
			return (
				opts.opencode?.(method, path, body) ?? {
					ok: false,
					status: 404,
					error: "404",
				}
			);
		},
		logTail: async () => opts.log ?? "",
	};
	controls = new Controls({
		lookup: (id) => agents.find((a) => a.id === id),
		sessions: { extensionFor: () => ext as Caller | undefined },
		ports,
		catalog: {
			home: () => opts.home ?? join(dir, "empty-home"),
			version: async () => opts.version ?? null,
		},
	});
	return { controls, pane, codexCalls, opencodeCalls };
}

const CLAUDE_CYCLE = ["default", "acceptEdits", "plan", "auto"];

describe("parsing", () => {
	test("a command line is one line: / and a name, then arguments", () => {
		expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
		expect(parseCommand("/gh:review 123 --fast")).toEqual({
			name: "gh:review",
			args: "123 --fast",
		});
		expect(parseCommand("compact")).toBeNull();
		expect(parseCommand("/ compact")).toBeNull();
		expect(parseCommand("/compact\nrm -rf /")).toBeNull();
		expect(parseCommand("/x \x1b[A")).toBeNull();
		expect(parseCommand(`/x ${"a".repeat(5000)}`)).toBeNull();
	});

	test("the last mode a log recorded", () => {
		expect(
			modeFromLog(
				"claude",
				'{"type":"permission-mode","permissionMode":"default"}\n{"permissionMode":"plan"}\n',
			),
		).toBe("plan");
		expect(
			modeFromLog(
				"codex",
				'{"type":"turn_context","payload":{"collaboration_mode":{"mode":"plan"}}}',
			),
		).toBe("plan");
		expect(modeFromLog("claude", "")).toBeNull();
		expect(modeFromLog("pi", '"permissionMode":"plan"')).toBeNull();
	});

	test("Claude's cycle: the modes passed on the way", () => {
		expect(claudePath("default", "plan")).toEqual(["acceptEdits"]);
		expect(claudePath("plan", "default")).toEqual([
			"bypassPermissions",
			"auto",
		]);
		expect(claudePath("auto", "default")).toEqual([]);
	});

	test("front matter: plain, quoted and block values", () => {
		expect(
			frontmatter(
				'---\nname: gh\ndescription: >\n  Reviews PRs\n  and pushes.\nargument-hint: "<pr>"\nuser-invocable: false\n---\nbody',
			),
		).toEqual({
			name: "gh",
			description: "Reviews PRs and pushes.",
			"argument-hint": "<pr>",
			"user-invocable": "false",
		});
		expect(frontmatter("no front matter")).toEqual({});
	});
});

describe("whose pane it is", () => {
	// pid → [ppid, args]
	const tree: Record<number, [number, string]> = {
		10: [1, "tmux"],
		20: [10, "-zsh"],
		30: [20, "claude"],
		40: [30, "/bin/zsh -c npm test"],
		50: [40, "claude -p review this"],
		60: [20, "codex"],
		61: [60, "codex"],
	};
	const proc = (p: number) =>
		tree[p] ? { ppid: tree[p]![0], args: tree[p]![1] } : undefined;
	const harnessOf = (args: string) => {
		const exe = args.split(/\s+/)[0];
		return exe === "claude" || exe === "codex" ? { id: exe } : null;
	};
	test("the agent started from the pane's shell owns it", () => {
		expect(ownsPane(30, 20, proc, harnessOf)).toBe(true);
	});
	test("a session started inside another agent's tool call does not", () => {
		expect(ownsPane(50, 20, proc, harnessOf)).toBe(false);
	});
	test("a launcher of the same harness right above is fine", () => {
		expect(ownsPane(61, 20, proc, harnessOf)).toBe(true);
	});
	test("a pane not up the chain is not its pane", () => {
		expect(ownsPane(30, 99, proc, harnessOf)).toBe(false);
	});
});

describe("Claude Code modes (tmux, Shift+Tab)", () => {
	test("reads the mode live from the footer", async () => {
		const { controls } = rig({
			pane: new FakePane("claude", CLAUDE_CYCLE, "plan"),
		});
		const m = await controls.modes("claude:s1");
		expect(m).toMatchObject({ current: "plan", live: true, canSwitch: true });
		expect(m.modes.map((x) => x.id)).toEqual([
			"default",
			"acceptEdits",
			"plan",
			"bypassPermissions",
			"auto",
		]);
	});

	test("not in tmux: the last mode its log recorded, and why it can't switch", async () => {
		const { controls } = rig({
			pane: null,
			log: '{"permissionMode":"acceptEdits"}',
		});
		expect(await controls.modes("claude:s1")).toMatchObject({
			current: "acceptEdits",
			live: false,
			canSwitch: false,
			reason: expect.stringContaining("tmux"),
		});
	});

	test("presses Shift+Tab until the footer shows the target", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE, "default");
		const { controls } = rig({ pane });
		const r = await controls.setMode(agent(), "plan");
		expect(r).toMatchObject({ result: "ok", via: "tmux", mode: "plan" });
		expect(pane.keys).toEqual(["BTab", "BTab"]);
	});

	test("already there: no key", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE, "auto");
		const r = await rig({ pane }).controls.setMode(agent(), "auto");
		expect(r.result).toBe("ok");
		expect(pane.keys).toEqual([]);
	});

	test("a mode off this session's cycle: one full turn, then unsupported", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE, "default");
		const r = await rig({ pane }).controls.setMode(
			agent(),
			"bypassPermissions",
		);
		expect(r).toMatchObject({
			result: "unsupported",
			detail: expect.stringContaining("not available"),
			mode: "default",
		});
		expect(pane.keys).toEqual(["BTab", "BTab", "BTab", "BTab"]);
	});

	test("mid-turn, a path through a permissive mode is refused before any key", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE, "plan");
		const r = await rig({ pane }).controls.setMode(
			agent({ status: "busy" }),
			"default",
		);
		expect(r.result).toBe("busy");
		expect(pane.keys).toEqual([]);
		// The same switch while idle goes ahead.
		const idle = await rig({ pane }).controls.setMode(agent(), "default");
		expect(idle).toMatchObject({ result: "ok", mode: "default" });
	});

	test("mid-turn, never into a mode that runs tools without asking", async () => {
		const full = [
			"default",
			"acceptEdits",
			"plan",
			"bypassPermissions",
			"auto",
		];
		for (const [from, to] of [
			["plan", "bypassPermissions"], // adjacent
			["acceptEdits", "bypassPermissions"], // one safe mode between
			["bypassPermissions", "auto"], // permissive to permissive
			["default", "auto"], // the long way round
		] as const) {
			const pane = new FakePane("claude", full, from);
			const r = await rig({ pane }).controls.setMode(
				agent({ status: "busy" }),
				to,
			);
			expect({ from, to, result: r.result }).toEqual({
				from,
				to,
				result: "busy",
			});
			expect(pane.keys).toEqual([]);
		}
	});

	test("mid-turn, a start mode Pulsar does not list (don't ask) is refused", async () => {
		const pane = new FakePane("claude", ["dontAsk", "default"], "dontAsk");
		const r = await rig({ pane }).controls.setMode(
			agent({ status: "busy" }),
			"default",
		);
		expect(r.result).toBe("busy");
		expect(pane.keys).toEqual([]);
	});

	test("mid-turn, a safe path is fine", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE, "default");
		const r = await rig({ pane }).controls.setMode(
			agent({ status: "busy" }),
			"plan",
		);
		expect(r.result).toBe("ok");
	});

	test("someone's unsent text, or a dialog: nothing is pressed", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE, "default");
		pane.input = "half a thought";
		expect((await rig({ pane }).controls.setMode(agent(), "plan")).result).toBe(
			"busy",
		);
		pane.input = "";
		pane.dialog = true;
		expect((await rig({ pane }).controls.setMode(agent(), "plan")).result).toBe(
			"blocked",
		);
		expect(pane.keys).toEqual([]);
	});

	test("an unknown mode id", async () => {
		const r = await rig({
			pane: new FakePane("claude", CLAUDE_CYCLE),
		}).controls.setMode(agent(), "build");
		expect(r.result).toBe("unsupported");
	});
});

describe("slash commands typed into the terminal", () => {
	test("Claude: typed into the empty input, then Enter", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		const r = await rig({ pane }).controls.run(
			agent(),
			"/compact keep the API notes",
		);
		expect(r).toMatchObject({ result: "ok", via: "tmux" });
		expect(pane.keys).toEqual(["text:/compact keep the API notes", "Enter"]);
		expect(pane.submitted).toEqual(["/compact keep the API notes"]);
	});

	test("a slow terminal: Enter waits until the text shows", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		pane.lag = 3;
		const r = await rig({ pane }).controls.run(agent(), "/recap");
		expect(r.result).toBe("ok");
		expect(pane.submitted).toEqual(["/recap"]);
	});

	test("the text never shows: no Enter, and it is taken back", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		pane.lag = 1000;
		const r = await rig({ pane }).controls.run(agent(), "/recap");
		expect(r).toMatchObject({
			result: "failed",
			detail: expect.stringContaining("taken back"),
		});
		expect(pane.keys).not.toContain("Enter");
		expect(pane.keys.filter((k) => k === "BSpace")).toHaveLength(
			"/recap".length,
		);
	});

	test("unsent text in the terminal: nothing typed", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		pane.input = "my draft";
		const r = await rig({ pane }).controls.run(agent(), "/compact");
		expect(r.result).toBe("busy");
		expect(pane.keys).toEqual([]);
	});

	test("a dialog on screen: nothing typed", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		pane.dialog = true;
		expect((await rig({ pane }).controls.run(agent(), "/compact")).result).toBe(
			"blocked",
		);
		expect(pane.keys).toEqual([]);
	});

	test("a line that is not one command is refused before the terminal", async () => {
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		for (const line of ["/compact\n!rm -rf ~", "hello", "/x\x1b[A"])
			expect((await rig({ pane }).controls.run(agent(), line)).result).toBe(
				"failed",
			);
		expect(pane.keys).toEqual([]);
	});

	test("not in tmux: unsupported, with the reason", async () => {
		const r = await rig({ pane: null }).controls.run(agent(), "/compact");
		expect(r).toMatchObject({
			result: "unsupported",
			detail: expect.stringContaining("tmux"),
		});
	});

	test("a harness Pulsar cannot read is never typed into", async () => {
		const a = agent({ id: "cursor:1", harness: "cursor" });
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		const r = await rig({ pane, agents: [a] }).controls.run(a, "/help");
		expect(r.result).toBe("unsupported");
		expect(pane.keys).toEqual([]);
	});
});

describe("Codex", () => {
	const codex = (over: Partial<Agent> = {}) =>
		agent({ id: "codex:t1", harness: "codex", sessionId: "t1", ...over });

	test("no pane: the mode through the app-server, with the effort Shift+Tab applies", async () => {
		const a = codex();
		const r0 = rig({
			pane: null,
			codexReady: true,
			codexThreadModel: "gpt-6",
			codexThreadEffort: "high",
			// The operator's config, as the TUI reads it for each mode.
			codexConfig: {
				model_reasoning_effort: "high",
				plan_mode_reasoning_effort: "xhigh",
			},
			agents: [a],
		});
		const r = await r0.controls.setMode(a, "plan");
		expect(r).toMatchObject({
			result: "ok",
			via: "codex-app-server",
			mode: "plan",
		});
		expect(r0.codexCalls).toEqual([
			["thread/read", { threadId: "t1" }],
			["collaborationMode/list", {}],
			["config/read", { cwd: a.cwd }],
			[
				"thread/settings/update",
				{
					threadId: "t1",
					collaborationMode: {
						mode: "plan",
						settings: {
							model: "gpt-6",
							reasoning_effort: "xhigh",
							developer_instructions: null,
						},
					},
				},
			],
		]);
		// Back to Default: the configured default effort.
		r0.codexCalls.length = 0;
		await r0.controls.setMode(a, "default");
		const update = r0.codexCalls.find(([m]) => m === "thread/settings/update");
		expect(
			(
				update![1] as {
					collaborationMode: { settings: { reasoning_effort: string } };
				}
			).collaborationMode.settings.reasoning_effort,
		).toBe("high");
	});

	test("nothing configured: the mode preset's effort", async () => {
		const a = codex();
		const r0 = rig({ pane: null, codexReady: true, agents: [a] });
		await r0.controls.setMode(a, "plan");
		const update = r0.codexCalls.find(([m]) => m === "thread/settings/update");
		expect(
			(
				update![1] as {
					collaborationMode: { settings: { reasoning_effort: string } };
				}
			).collaborationMode.settings.reasoning_effort,
		).toBe("medium");
	});

	test("in its pane: Shift+Tab, as the operator would press it", async () => {
		const pane = new FakePane("codex", ["default", "plan"]);
		const a = codex();
		const r0 = rig({ pane, codexReady: true, agents: [a] });
		expect(await r0.controls.setMode(a, "plan")).toMatchObject({
			result: "ok",
			via: "tmux",
			mode: "plan",
		});
		expect(r0.codexCalls).toEqual([]);
		expect(pane.keys).toEqual(["BTab"]);
	});

	test("no app-server: Shift+Tab in its pane", async () => {
		const pane = new FakePane("codex", ["default", "plan"]);
		const a = codex();
		const r = await rig({
			pane,
			codexReady: false,
			agents: [a],
		}).controls.setMode(a, "plan");
		expect(r).toMatchObject({ result: "ok", via: "tmux", mode: "plan" });
		expect(pane.keys).toEqual(["BTab"]);
	});

	test("mid-turn: refused, as the TUI does", async () => {
		const a = codex({ status: "busy" });
		const r0 = rig({
			pane: new FakePane("codex", ["default", "plan"]),
			codexReady: true,
			agents: [a],
		});
		expect((await r0.controls.setMode(a, "plan")).result).toBe("busy");
		expect(r0.codexCalls).toEqual([]);
	});

	test("a skill runs as a `$name` mention; a command as typed", async () => {
		const home = join(dir, "codex-home");
		mkdirSync(join(home, ".codex", "skills", "lint-fix"), { recursive: true });
		writeFileSync(
			join(home, ".codex", "skills", "lint-fix", "SKILL.md"),
			"---\nname: lint-fix\ndescription: Fix lint\n---\n",
		);
		const pane = new FakePane("codex", ["default", "plan"]);
		const a = codex();
		const { controls } = rig({ pane, home, agents: [a] });
		expect((await controls.run(a, "/lint-fix src/")).result).toBe("ok");
		expect((await controls.run(a, "/compact")).result).toBe("ok");
		expect(pane.submitted).toEqual(["$lint-fix src/", "/compact"]);
	});
});

describe("OpenCode", () => {
	const oc = (over: Partial<Agent> = {}) =>
		agent({
			id: "opencode:ses1",
			harness: "opencode",
			sessionId: "ses1",
			...over,
		});
	const api =
		(state: { agent: string }) =>
		(method: string, path: string, body?: unknown): ApiResult => {
			if (path.startsWith("/api/command"))
				return {
					ok: true,
					body: { data: [{ name: "review", description: "Review" }] },
				};
			if (path.startsWith("/api/skill"))
				return {
					ok: true,
					body: { data: [{ id: "sk_1", name: "gh", description: "GitHub" }] },
				};
			if (method === "POST" && path.endsWith("/agent")) {
				state.agent = (body as { agent: string }).agent;
				return { ok: true, body: null };
			}
			if (method === "GET" && path === "/api/session/ses1")
				return { ok: true, body: { data: { id: "ses1", agent: state.agent } } };
			return { ok: true, body: null };
		};

	test("folder guesses cannot run a command or switch a terminal or service mode", async () => {
		const a = oc({ registered: false, meta: { sessionFrom: "folder" } });
		const pane = new FakePane("opencode", ["build", "plan"]);
		const { controls, opencodeCalls } = rig({
			pane,
			opencode: api({ agent: "build" }),
			agents: [a],
		});
		expect(await controls.commands(a.id)).toMatchObject({
			commands: [],
			runnable: false,
		});
		expect(await controls.modes(a.id)).toMatchObject({
			modes: [],
			canSwitch: false,
		});
		for (const cmd of ["/review", "/undo"])
			expect((await controls.run(a, cmd)).result).toBe("unsupported");
		expect((await controls.setMode(a, "plan")).result).toBe("unsupported");
		expect(pane.keys).toEqual([]);
		expect(pane.submitted).toEqual([]);
		expect(opencodeCalls).toEqual([]);
	});

	test("no pane: the mode through its API, with the caveat", async () => {
		const state = { agent: "build" };
		const a = oc();
		const r0 = rig({ pane: null, opencode: api(state), agents: [a] });
		expect(await r0.controls.modes(a.id)).toMatchObject({
			current: "build",
			live: true,
			canSwitch: true,
			note: expect.stringContaining("terminal"),
		});
		expect(await r0.controls.setMode(a, "plan")).toMatchObject({
			result: "ok",
			via: "opencode-api",
			mode: "plan",
		});
		expect(state.agent).toBe("plan");
	});

	test("in tmux: Shift+Tab, read back from the screen", async () => {
		const pane = new FakePane("opencode", ["build", "plan"]);
		const a = oc();
		const r = await rig({
			pane,
			opencode: api({ agent: "build" }),
			agents: [a],
		}).controls.setMode(a, "plan");
		expect(r).toMatchObject({ result: "ok", via: "tmux", mode: "plan" });
	});

	test("server commands and skills through the API; TUI commands typed", async () => {
		const pane = new FakePane("opencode", ["build", "plan"]);
		const a = oc();
		const r0 = rig({ pane, opencode: api({ agent: "build" }), agents: [a] });
		expect((await r0.controls.run(a, "/review HEAD~1")).via).toBe(
			"opencode-api",
		);
		expect((await r0.controls.run(a, "/gh open the PR")).via).toBe(
			"opencode-api",
		);
		expect((await r0.controls.run(a, "/undo")).via).toBe("tmux");
		const posts = r0.opencodeCalls.filter((c) => c.method === "POST");
		expect(posts).toEqual([
			{
				method: "POST",
				path: "/api/session/ses1/command",
				body: { name: "review", text: "HEAD~1" },
			},
			{
				method: "POST",
				path: "/api/session/ses1/prompt",
				body: {
					text: "open the PR",
					skills: [{ id: "sk_1" }],
					delivery: "queue",
					resume: true,
				},
			},
		]);
		expect(pane.submitted).toEqual(["/undo"]);
	});
});

describe("pi and omp through the extension", () => {
	for (const harness of ["pi", "omp"] as const) {
		test(
			harness +
				" terminal commands preserve drafts and target only the parent pane",
			async () => {
				const pane = new FakePane(harness, ["default"]);
				const a = agent({ id: `${harness}:1`, harness });
				const { controls } = rig({ agents: [a], pane });
				expect((await controls.run(a, "/compact")).result).toBe("ok");
				expect(pane.submitted).toEqual(["/compact"]);
				pane.input = "unsent";
				expect((await controls.run(a, "/compact")).result).toBe("busy");
				expect(
					(
						await controls.run(
							{ ...a, meta: { subagentOf: "parent" } },
							"/compact",
						)
					).result,
				).toBe("unsupported");
				expect(pane.input).toBe("unsent");
			},
		);
	}
	test("omp plan mode", async () => {
		const a = agent({ id: "omp:1", harness: "omp" });
		let plan = false;
		const { controls } = rig({
			agents: [a],
			extension: (req) => {
				if (req.kind === "mode.get")
					return { result: "ok", mode: plan ? "plan" : "default" };
				if (req.kind === "mode.set") {
					plan = req.mode === "plan";
					return { result: "ok", mode: plan ? "plan" : "default" };
				}
				return null;
			},
		});
		expect(await controls.modes(a.id)).toMatchObject({
			current: "default",
			canSwitch: true,
		});
		expect(await controls.setMode(a, "plan")).toMatchObject({
			result: "ok",
			via: "extension",
			mode: "plan",
		});
		expect(plan).toBe(true);
	});

	test("pi: a command goes to the extension; its commands fill the menu", async () => {
		const a = agent({ id: "pi:1", harness: "pi", cwd: "/w" });
		const lines: string[] = [];
		const { controls } = rig({
			agents: [a],
			extension: (req) => {
				if (req.kind === "command") {
					lines.push(String(req.line));
					return { result: "ok" };
				}
				if (req.kind === "commands")
					return {
						result: "ok",
						commands: [
							{
								name: "skill:tidy",
								description: "Tidy",
								source: "skill",
								path: "/w/.pi/skills/tidy/SKILL.md",
							},
							{ name: "deploy", description: "Ship it", source: "extension" },
							{ name: "bad name!", description: "x" },
						],
					};
				return null;
			},
		});
		expect(await controls.run(a, "/skill:tidy src")).toMatchObject({
			result: "ok",
			via: "extension",
		});
		expect(lines).toEqual(["/skill:tidy src"]);
		const cat = await controls.commands(a.id);
		expect(cat.runnable).toBe(true);
		const mine = cat.commands.filter((c) => c.source !== "builtin");
		expect(mine).toEqual([
			{
				name: "skill:tidy",
				description: "Tidy",
				source: "project",
				skill: true,
			},
			{ name: "deploy", description: "Ship it", source: "user" },
		]);
	});

	for (const harness of ["pi", "omp"]) {
		test(`${harness}: a live setting replaces its terminal picker and reads back immediately`, async () => {
			const a = agent({ id: `${harness}:settings`, harness });
			let value = "a/model";
			const { controls } = rig({
				agents: [a],
				extension: (req) => {
					if (req.kind === "setting" && req.line === "/model b/model") {
						value = "b/model";
						return { result: "ok" };
					}
					if (req.kind === "commands")
						return {
							result: "ok",
							commands: [
								{
									name: "model",
									source: "agent",
									currentArgument: value,
									argumentChoices: ["a/model", "b/model"].map((value) => ({
										value,
										label: value,
									})),
								},
							],
						};
					return null;
				},
			});
			const menu = async () =>
				(await controls.commands(a.id)).commands.filter(
					(c) => c.name === "model",
				);
			expect(await menu()).toMatchObject([
				{ currentArgument: "a/model", source: "agent" },
			]);
			expect(await controls.run(a, "/model b/model")).toMatchObject({
				result: "ok",
				via: "extension",
			});
			expect(await menu()).toMatchObject([{ currentArgument: "b/model" }]);
		});
	}

	test("no extension connected: unsupported, nothing waits", async () => {
		const a = agent({ id: "omp:2", harness: "omp" });
		const none = rig({ agents: [a] }).controls;
		expect(await none.setMode(a, "plan")).toMatchObject({
			result: "unsupported",
			via: "extension",
		});
		expect(await none.modes(a.id)).toMatchObject({ canSwitch: false });
	});

	test("an answer from another agent is ignored; the asked agent's counts", async () => {
		const a = agent({ id: "omp:asked", harness: "omp" });
		const pending: Array<Record<string, unknown>> = [];
		// The extension hears the request but does not answer on its own.
		const { controls } = rig({
			agents: [a],
			extension: (req) => {
				pending.push(req);
				return null;
			},
		});
		const read = controls.modes(a.id);
		await Promise.resolve();
		const requestId = pending[0]!.requestId;
		expect(typeof requestId).toBe("string");
		// Another agent answering with the real id: refused, still pending.
		expect(
			controls.answer("omp:intruder", {
				requestId,
				result: "ok",
				mode: "plan",
			}),
		).toEqual({ ok: false });
		let settled = false;
		void read.then(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false);
		// The asked agent's answer resolves it.
		expect(
			controls.answer(a.id, { requestId, result: "ok", mode: "default" }),
		).toEqual({ ok: true });
		expect(await read).toMatchObject({ current: "default", canSwitch: true });
	});
});

describe("the / menu", () => {
	test("Claude: built-ins, project and user commands and skills, enabled plugins", async () => {
		const home = join(dir, "home-claude");
		const proj = join(dir, "proj");
		const mk = (path: string, text: string) => {
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, text);
		};
		mkdirSync(join(proj, ".git"), { recursive: true });
		mk(
			join(proj, ".claude", "commands", "ship.md"),
			"---\ndescription: Ship it\nargument-hint: <version>\n---\nbody",
		);
		mk(
			join(proj, ".claude", "skills", "local-skill", "SKILL.md"),
			"---\nname: local-skill\ndescription: Local\n---\n",
		);
		mk(join(home, ".claude", "commands", "standup.md"), "Write my standup\n");
		mk(
			join(home, ".claude", "skills", "mine", "SKILL.md"),
			"---\nname: mine\ndescription: Mine\n---\n",
		);
		mk(
			join(home, ".claude", "skills", "hidden", "SKILL.md"),
			"---\nname: hidden\ndescription: x\nuser-invocable: false\n---\n",
		);
		const plug = join(home, ".claude", "plugins", "cache", "m", "gh", "1.0.0");
		mk(
			join(plug, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review a PR\n---\n",
		);
		mk(
			join(plug, "commands", "open-pr.md"),
			"---\ndescription: Open a PR\n---\n",
		);
		mk(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "gh@m": true, "off@m": false } }),
		);
		mk(
			join(home, ".claude", "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: { "gh@m": [{ scope: "user", installPath: plug }] },
			}),
		);
		const pane = new FakePane("claude", CLAUDE_CYCLE);
		const { controls } = rig({ pane, home, version: "2.1.330" });
		const cat = await controls.commands("claude:s1");
		expect(cat).toMatchObject({ runnable: true, harness: "claude" });
		expect(cat.stale).toBeUndefined();
		const names = cat.commands.map((c) => `${c.source}:${c.name}`);
		expect(names).toContain("builtin:compact");
		expect(names).toContain("project:ship");
		expect(names).toContain("project:local-skill");
		expect(names).toContain("user:standup");
		expect(names).toContain("user:mine");
		expect(names).toContain("plugin:gh:review");
		expect(names).toContain("plugin:gh:open-pr");
		expect(names).not.toContain("user:hidden");
		expect(cat.commands.find((c) => c.name === "ship")).toEqual({
			name: "ship",
			description: "Ship it",
			source: "project",
			args: "<version>",
		});
		expect(cat.commands.find((c) => c.name === "standup")?.description).toBe(
			"Write my standup",
		);
		expect(cat.commands.find((c) => c.name === "config")?.dialog).toBe(true);
	});

	test("an installed CLI newer than the built-in list is flagged", async () => {
		const { controls } = rig({
			pane: new FakePane("claude", CLAUDE_CYCLE),
			version: "2.2.0",
		});
		expect((await controls.commands("claude:s1")).stale).toBe(true);
	});

	test("qualified native catalogs distinguish terminal dialogs, skills and commands", () => {
		const claude = builtinsFor("claude", "2.1.331")!;
		expect(claude.commands.map((command) => command.name)).toContain(
			"list-agents",
		);
		const codex = builtinsFor("codex", "codex-cli 0.172.0")!;
		const omp = builtinsFor("omp", "19.1.1")!;
		const agy = builtinsFor("antigravity", "1.5.18")!;
		for (const catalog of [claude, codex, omp, agy]) {
			expect(catalog.stale).toBe(false);
			const names = catalog.commands.map((command) => command.name);
			expect(new Set(names).size).toBe(names.length);
		}
		const codexNames = codex.commands.map((command) => command.name);
		expect(codexNames).toEqual(
			expect.arrayContaining(["stop", "config", "subagents", "keymap"]),
		);
		expect(codexNames).not.toContain("test-approval");
		expect(
			omp.commands.find((command) => command.name === "model"),
		).toMatchObject({ dialog: true });
		expect(
			omp.commands.find((command) => command.name === "model")?.args,
		).toBeUndefined();
		expect(
			omp.commands.find((command) => command.name === "switch")?.args,
		).toBe("[model]");
		expect(
			agy.commands.find((command) => command.name === "compact"),
		).toMatchObject({ terminalOnly: true, args: "[message]" });
		expect(agy.commands.some((command) => command.name === "swarm")).toBe(
			false,
		);
		expect(builtinsFor("antigravity", "1.5.19")?.stale).toBe(true);
	});

	test("not runnable: the reason travels with the list", async () => {
		const cat = await rig({ pane: null }).controls.commands("claude:s1");
		expect(cat.runnable).toBe(false);
		expect(cat.reason).toContain("tmux");
		expect(cat.commands.length).toBeGreaterThan(10);
	});
});
