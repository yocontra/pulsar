import { randomBytes } from "node:crypto";
import { codexControlReady, codexRpc } from "../harnesses/codex-rpc.ts";
import { driverFor } from "../harnesses/index.ts";
import {
	type ApiResult,
	opencodeRequest,
	opencodeServiceRunning,
} from "../harnesses/opencode-api.ts";
import {
	readScreen,
	type Screen,
	type ScreenHarness,
	stripAnsi,
} from "../harnesses/screens.ts";
import type {
	AgentModes,
	CommandCatalog,
	ControlResult,
	ModeOption,
} from "../http/wire.ts";
import { processSnapshot } from "../processes.ts";
import { RpcError } from "../rpc.ts";
import {
	capture,
	paneOf,
	panePid,
	sendKeys,
	type TmuxResult,
} from "../tmux.ts";
import type { Agent } from "../types.ts";
import { tailAsync } from "../util.ts";
import type { Acting } from "./acting.ts";
import type { Principal } from "./caller.ts";
import { type CatalogPorts, Catalogs } from "./catalog.ts";
import type { Sessions } from "./sessions.ts";

/**
 * Agent modes and slash commands from the app (src/http/wire.ts
 * `AgentModes`, `CommandCatalog`, `ControlResult`).
 *
 * How each harness is driven (see docs in the PR and test/controls.test.ts):
 * - Claude Code: only its terminal. Its socket takes messages, never
 *   commands (it queues peers with slash commands off) and has no mode
 *   control, so Pulsar presses Shift+Tab in the agent's tmux pane, one press
 *   at a time, and reads the footer back after each; commands are typed
 *   into an empty input box and sent with Enter.
 * - Codex: the mode through the app-server daemon its TUI runs in
 *   (`thread/settings/update`; the TUI's footer follows, checked live);
 *   commands typed into its tmux pane.
 * - OpenCode: Shift+Tab in its pane, else its API (`/agent`; the terminal
 *   may not follow); server commands and skills through its API, the TUI's
 *   own commands typed into its pane.
 * - pi, omp: through the pulsar extension in the session (omp's plan mode;
 *   pi's extension commands, prompt templates and skills).
 *
 * Commands never go through message delivery: no inbox, no redelivery, so
 * a retry can never type a command twice, and a message from an agent that
 * starts with `/` is only ever text. Switching and running are acting ops
 * (Prove Human; on another machine its home node checks the proof).
 */

/** Everything outside the service, so tests run on fakes. */
export interface ControlPorts {
	pane(agent: Agent): Promise<string | null>;
	/** The pane with colours (`capture-pane -e`). */
	capture(pane: string): Promise<string | null>;
	keys(pane: string, keys: string[]): Promise<TmuxResult>;
	text(pane: string, text: string): Promise<TmuxResult>;
	sleep(ms: number): Promise<void>;
	codexReady(): Promise<boolean>;
	codex(calls: Array<[string, unknown]>): Promise<unknown[]>;
	opencode(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<ApiResult>;
	/** The tail of the agent's own log, for the mode it last recorded. */
	logTail(agent: Agent): Promise<string>;
}

export const realControlPorts: ControlPorts = {
	async pane(agent) {
		const pane = await paneOf(agent);
		// Typed keys go only to the agent's own terminal: never to a pane
		// whose process chain runs another agent first (a session started
		// from inside another agent's tool call inherits its tmux pane).
		return pane && agent.pid && (await paneOwnedBy(pane, agent.pid))
			? pane
			: null;
	},
	capture: async (pane) => capture(pane, { ansi: true }),
	keys: (pane, keys) => sendKeys(pane, { keys }),
	text: (pane, text) => sendKeys(pane, { text }),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	codexReady: () => codexControlReady(),
	codex: (calls) => codexRpc(calls, { experimental: true, timeoutMs: 8000 }),
	async opencode(method, path, body) {
		const table = await processSnapshot(2000, "user");
		if (!opencodeServiceRunning(table))
			return {
				ok: false,
				status: null,
				error: "OpenCode service is not running",
			};
		return opencodeRequest(table, method, path, {
			...(body !== undefined ? { body } : {}),
			timeoutMs: 20_000,
			lane: "user",
		});
	},
	async logTail(agent) {
		const where = await driverFor(agent.harness)?.transcript?.locate(agent);
		return where?.kind === "file" ? tailAsync(where.path, 512 * 1024) : "";
	},
};

/** Up the agent's process tree from it to the pane's own process: no other harness on the way. */
export async function paneOwnedBy(pane: string, pid: number): Promise<boolean> {
	const root = await panePid(pane);
	if (!root) return false;
	if (pid === root) return true;
	const { driverForProcess } = await import("../harnesses/index.ts");
	const table = await processSnapshot(2000, "user");
	return ownsPane(pid, root, (p) => table.get(p), driverForProcess);
}

/**
 * The walk `paneOwnedBy` makes, on a process table: true when `root` is up
 * the chain from `pid` with no other agent between them. The direct parent
 * may be the same harness (a launcher that execs the real binary).
 */
export function ownsPane(
	pid: number,
	root: number,
	proc: (pid: number) => { ppid: number; args: string } | undefined,
	harnessOf: (args: string) => { id: string } | null,
): boolean {
	const own = harnessOf(proc(pid)?.args ?? "")?.id ?? null;
	let p = proc(pid)?.ppid;
	for (let hops = 0; p && p > 1 && hops < 8; hops++) {
		if (p === root) return true;
		const h = harnessOf(proc(p)?.args ?? "");
		if (h && !(hops === 0 && h.id === own)) return false;
		p = proc(p)?.ppid;
	}
	return false;
}

const plan: ModeOption = {
	id: "plan",
	label: "Plan",
	hint: "Researches and plans; changes nothing",
};

/** Each harness's modes. Claude Code's order is its Shift+Tab cycle. */
export const MODES: Record<string, ModeOption[]> = {
	claude: [
		{ id: "default", label: "Manual", hint: "Asks before edits and commands" },
		{
			id: "acceptEdits",
			label: "Accept edits",
			hint: "Edits files without asking",
		},
		plan,
		{
			id: "bypassPermissions",
			label: "Bypass permissions",
			hint: "Runs everything without asking (only if the session started with it)",
		},
		{ id: "auto", label: "Auto", hint: "Approves safe actions on its own" },
	],
	codex: [{ id: "default", label: "Default" }, plan],
	opencode: [{ id: "build", label: "Build" }, plan],
	omp: [{ id: "default", label: "Default" }, plan],
};

/** Modes that run tools without asking: never passed through mid-turn. */
const PERMISSIVE = new Set(["bypassPermissions", "auto", "dontAsk"]);

/** Shift+Tab presses before giving up (Claude has at most five modes in its cycle). */
const MAX_PRESSES = 6;
/** How long a key press has to show on screen, and how often to look. */
const SETTLE_MS = 1500;
const POLL_MS = 100;

const NOT_IN_TMUX =
	"The agent does not run in tmux, so Pulsar cannot reach its terminal.";
const NO_EXTENSION = "The pulsar extension is not connected in this session.";
/** How long an extension has to answer. */
const EXTENSION_TIMEOUT_MS = 5000;

/** Harnesses whose screen Pulsar can read (and so type into safely). */
const SCREENS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

/** Remote agents: their home node answers (federation). */
export interface RemoteControls {
	modes(address: string, as?: Principal): Promise<AgentModes>;
	commands(address: string, as?: Principal): Promise<CommandCatalog>;
}

/** A `/name args` line, checked: one line, a command name. */
export function parseCommand(
	line: string,
): { name: string; args: string } | null {
	if (typeof line !== "string" || line.length > 4000) return null;
	// One line, printable: no newline submits early, no escape drives the TUI.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
	if (/[\x00-\x1f\x7f]/.test(line)) return null;
	const m = /^\/([A-Za-z0-9][A-Za-z0-9:_.-]{0,127})(?: +(.*))?$/.exec(line);
	if (!m) return null;
	return { name: m[1]!, args: (m[2] ?? "").trim() };
}

/** The last mode a Claude or Codex log recorded; null when none. */
export function modeFromLog(harness: string, tail: string): string | null {
	const re =
		harness === "claude"
			? /"permissionMode":"([A-Za-z]+)"/g
			: harness === "codex"
				? /"collaboration_mode":\{"mode":"([a-z]+)"/g
				: null;
	if (!re) return null;
	let last: string | null = null;
	for (const m of tail.matchAll(re)) last = m[1]!;
	return last;
}

/**
 * The modes passed between `from` and `to` on Claude Code's Shift+Tab cycle
 * (as if every mode were available: the real cycle only skips some).
 */
export function claudePath(from: string, to: string): string[] {
	const order = MODES.claude!.map((m) => m.id);
	const i = order.indexOf(from);
	const j = order.indexOf(to);
	if (i < 0 || j < 0) return [];
	const out: string[] = [];
	for (let k = (i + 1) % order.length; k !== j; k = (k + 1) % order.length)
		out.push(order[k]!);
	return out;
}

export class Controls {
	remote: RemoteControls | null = null;
	readonly catalogs: Catalogs;
	private readonly lookup: (id: string) => Agent | undefined;
	private readonly sessions: Pick<Sessions, "extensionFor">;
	private readonly ports: ControlPorts;
	private pending = new Map<
		string,
		{ agentId: string; resolve: (r: Record<string, unknown> | null) => void }
	>();

	constructor(deps: {
		lookup: (id: string) => Agent | undefined;
		sessions: Pick<Sessions, "extensionFor">;
		acting?: Acting;
		ports?: Partial<ControlPorts>;
		catalog?: Partial<CatalogPorts>;
	}) {
		this.lookup = deps.lookup;
		this.sessions = deps.sessions;
		this.ports = { ...realControlPorts, ...deps.ports };
		this.catalogs = new Catalogs({
			opencode: this.ports.opencode,
			extension: (agent) => this.askExtension(agent, { kind: "commands" }),
			...deps.catalog,
		});
		deps.acting?.register("agents.mode", async ({ agent, params }) =>
			this.setMode(this.local(agent!), modeParam(params)),
		);
		deps.acting?.register("agents.command", async ({ agent, params }) =>
			this.run(this.local(agent!), lineParam(params)),
		);
	}

	private local(id: string): Agent {
		const agent = this.lookup(id);
		if (!agent || agent.status === "gone")
			throw new RpcError("not_found", `no agent ${id}`);
		return agent;
	}

	// ---- reads ----

	/** `GET /agents/:id/modes`. Callers authorize first. */
	async modes(agentId: string, as?: Principal): Promise<AgentModes> {
		const agent = this.lookup(agentId);
		if (!agent) {
			if (this.remote && agentId.includes("/"))
				return this.remote.modes(agentId, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		return this.readModes(agent);
	}

	/** `GET /agents/:id/commands`. Callers authorize first. */
	async commands(agentId: string, as?: Principal): Promise<CommandCatalog> {
		const agent = this.lookup(agentId);
		if (!agent) {
			if (this.remote && agentId.includes("/"))
				return this.remote.commands(agentId, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		const commands = await this.catalogs.list(agent);
		const how = await this.commandPath(agent);
		return {
			agentId: agent.id,
			harness: agent.harness,
			commands: commands.commands,
			runnable: how.ok,
			...(how.ok ? {} : { reason: how.reason }),
			...(commands.stale ? { stale: true } : {}),
		};
	}

	/** Whether commands can run for this agent at all, and why not. */
	private async commandPath(
		agent: Agent,
	): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (agent.status === "gone")
			return { ok: false, reason: "The agent is gone." };
		if (agent.harness === "pi" && this.sessions.extensionFor(agent.id))
			return { ok: true };
		if (agent.harness === "opencode" && agent.sessionId) return { ok: true };
		if (!SCREENS.has(agent.harness))
			return {
				ok: false,
				reason:
					agent.harness === "omp"
						? "omp runs commands only when typed in its terminal, and Pulsar cannot read it."
						: "Pulsar cannot run commands for this harness.",
			};
		return (await this.ports.pane(agent))
			? { ok: true }
			: { ok: false, reason: NOT_IN_TMUX };
	}

	private async screen(pane: string, harness: string): Promise<Screen | null> {
		if (!SCREENS.has(harness)) return null;
		const text = await this.ports.capture(pane);
		return text === null ? null : readScreen(harness as ScreenHarness, text);
	}

	private async readModes(agent: Agent): Promise<AgentModes> {
		const modes = MODES[agent.harness] ?? [];
		const base = { agentId: agent.id, modes };
		if (modes.length === 0)
			return {
				...base,
				current: null,
				live: false,
				canSwitch: false,
				reason: "This harness has no modes Pulsar can switch.",
			};
		const logged = async () =>
			modeFromLog(
				agent.harness,
				await this.ports.logTail(agent).catch(() => ""),
			);

		if (agent.harness === "omp") {
			if (!this.sessions.extensionFor(agent.id))
				return {
					...base,
					current: null,
					live: false,
					canSwitch: false,
					reason: NO_EXTENSION,
				};
			const r = await this.askExtension(agent, { kind: "mode.get" });
			const mode = typeof r?.mode === "string" ? r.mode : null;
			return r?.result === "ok"
				? { ...base, current: mode, live: true, canSwitch: true }
				: {
						...base,
						current: mode,
						live: mode !== null,
						canSwitch: false,
						reason: String(
							r?.detail ?? "The extension cannot switch modes here.",
						),
					};
		}

		const pane = await this.ports.pane(agent);
		const s = pane ? await this.screen(pane, agent.harness) : null;
		if (s?.recognized && s.mode)
			return { ...base, current: s.mode, live: true, canSwitch: true };

		if (
			agent.harness === "codex" &&
			agent.sessionId &&
			(await this.ports.codexReady())
		)
			return { ...base, current: await logged(), live: false, canSwitch: true };

		if (agent.harness === "opencode" && agent.sessionId) {
			const r = await this.ports.opencode(
				"GET",
				`/api/session/${encodeURIComponent(agent.sessionId)}`,
			);
			const current = r.ok ? opencodeAgentOf(r.body) : null;
			if (r.ok)
				return {
					...base,
					current,
					live: current !== null,
					canSwitch: true,
					note: "Switching may not update the terminal view.",
				};
		}

		return {
			...base,
			current: await logged(),
			live: false,
			canSwitch: false,
			reason: pane
				? "The terminal shows a dialog or menu; switch when it is back at the prompt."
				: NOT_IN_TMUX,
		};
	}

	// ---- mode switch ----

	/** Switches an agent's mode (the `agents.mode` acting op). */
	async setMode(agent: Agent, target: string): Promise<ControlResult> {
		const done = (r: Omit<ControlResult, "agentId">): ControlResult => ({
			agentId: agent.id,
			...r,
		});
		const modes = MODES[agent.harness] ?? [];
		if (!modes.some((m) => m.id === target))
			return done({
				result: "unsupported",
				via: agent.harness,
				detail: modes.length
					? `${agent.harness} has no mode ${target}`
					: "This harness has no modes Pulsar can switch.",
			});

		if (agent.harness === "omp") {
			if (!this.sessions.extensionFor(agent.id))
				return done({
					result: "unsupported",
					via: "extension",
					detail: NO_EXTENSION,
				});
			const r = await this.askExtension(agent, {
				kind: "mode.set",
				mode: target,
			});
			return done(extensionOutcome(r, "mode"));
		}

		if (agent.harness === "codex") {
			// The TUI refuses a switch during a turn; so does Pulsar.
			if (agent.status === "busy")
				return done({
					result: "busy",
					via: "codex",
					detail: "Codex runs a turn; switch when it is idle.",
				});
			// In its pane, Shift+Tab is exactly what the operator would press
			// (the TUI applies its own per-mode effort); the app-server
			// otherwise.
			if (
				agent.sessionId &&
				!(await this.ports.pane(agent)) &&
				(await this.ports.codexReady())
			)
				return done(await this.codexSet(agent, target));
		}

		if (agent.harness === "opencode" && agent.sessionId) {
			const pane = await this.ports.pane(agent);
			if (!pane) return done(await this.opencodeSet(agent, target));
		}

		const pane = await this.ports.pane(agent);
		if (!pane || !SCREENS.has(agent.harness))
			return done({ result: "unsupported", via: "tmux", detail: NOT_IN_TMUX });
		return done(await this.cycle(agent, pane, target));
	}

	/**
	 * Presses Shift+Tab until the footer shows `target`, reading the screen
	 * after every press. Stops on a screen it does not know, after a full
	 * turn of the cycle (the mode is not on it), or after MAX_PRESSES.
	 */
	private async cycle(
		agent: Agent,
		pane: string,
		target: string,
	): Promise<Omit<ControlResult, "agentId">> {
		const via = "tmux";
		const first = await this.screen(pane, agent.harness);
		if (!first?.recognized || !first.mode)
			return {
				result: "blocked",
				via,
				detail: "The terminal shows a dialog or menu, not the prompt.",
			};
		if (first.mode === target) return { result: "ok", via, mode: target };
		if (first.input === "draft")
			return {
				result: "busy",
				via,
				detail: "Someone has unsent text in the agent's terminal.",
			};
		if (
			agent.harness === "claude" &&
			agent.status === "busy" &&
			claudePath(first.mode, target).some((m) => PERMISSIVE.has(m))
		)
			return {
				result: "busy",
				via,
				detail: `The way to ${target} passes a mode that runs tools without asking; switch when the agent is idle.`,
			};
		let mode = first.mode;
		for (let press = 0; press < MAX_PRESSES; press++) {
			const sent = await this.ports.keys(pane, ["BTab"]);
			if (!sent.ok) return { result: "failed", via, detail: sent.error };
			const now = await this.until(pane, agent.harness, (s) => s.mode !== mode);
			if (!now?.recognized || !now.mode)
				return {
					result: "blocked",
					via,
					detail: `The terminal stopped showing the prompt (last seen in ${mode}).`,
					mode,
				};
			if (now.mode === mode)
				return {
					result: "failed",
					via,
					detail: "The mode did not change after Shift+Tab.",
					mode,
				};
			mode = now.mode;
			if (mode === target) return { result: "ok", via, mode };
			if (mode === first.mode)
				return {
					result: "unsupported",
					via,
					detail: `${target} is not available in this session.`,
					mode,
				};
		}
		return { result: "failed", via, detail: `Did not reach ${target}.`, mode };
	}

	/** Reads the screen until `done` holds or SETTLE_MS passes; the last screen read. */
	private async until(
		pane: string,
		harness: string,
		done: (s: Screen) => boolean,
	): Promise<Screen | null> {
		let s: Screen | null = null;
		for (let waited = 0; waited <= SETTLE_MS; waited += POLL_MS) {
			await this.ports.sleep(POLL_MS);
			s = await this.screen(pane, harness);
			if (!s?.recognized || done(s)) return s;
		}
		return s;
	}

	private async codexSet(
		agent: Agent,
		target: string,
	): Promise<Omit<ControlResult, "agentId">> {
		const via = "codex-app-server";
		try {
			const threadId = agent.sessionId!;
			const [read, presets] = (await this.ports.codex([
				["thread/read", { threadId }],
				["collaborationMode/list", {}],
			])) as [
				{ thread?: { model?: unknown; reasoningEffort?: unknown } } | undefined,
				(
					| { data?: Array<{ mode?: unknown; reasoning_effort?: unknown }> }
					| undefined
				),
			];
			const model = read?.thread?.model;
			// Only the mode changes: the thread keeps its reasoning effort (the
			// preset's when the thread names none).
			const preset = presets?.data?.find((p) => p.mode === target);
			const current = read?.thread?.reasoningEffort;
			const effort =
				typeof current === "string"
					? current
					: typeof preset?.reasoning_effort === "string"
						? preset.reasoning_effort
						: null;
			if (typeof model !== "string" || !model)
				return {
					result: "failed",
					via,
					detail: "Codex did not say which model the thread uses.",
				};
			await this.ports.codex([
				[
					"thread/settings/update",
					{
						threadId,
						collaborationMode: {
							mode: target,
							settings: {
								model,
								reasoning_effort: effort,
								developer_instructions: null,
							},
						},
					},
				],
			]);
		} catch (e) {
			return { result: "failed", via, detail: (e as Error).message };
		}
		// Read it back from the terminal when there is one.
		const pane = await this.ports.pane(agent);
		if (pane) {
			const s = await this.until(pane, "codex", (x) => x.mode === target);
			if (s?.recognized && s.mode !== target)
				return {
					result: "failed",
					via,
					detail: "The terminal still shows the old mode.",
					mode: s.mode,
				};
		}
		return { result: "ok", via, mode: target };
	}

	private async opencodeSet(
		agent: Agent,
		target: string,
	): Promise<Omit<ControlResult, "agentId">> {
		const via = "opencode-api";
		const path = `/api/session/${encodeURIComponent(agent.sessionId!)}`;
		const r = await this.ports.opencode("POST", `${path}/agent`, {
			agent: target,
		});
		if (!r.ok) return { result: "failed", via, detail: r.error };
		const back = await this.ports.opencode("GET", path);
		const mode = back.ok ? opencodeAgentOf(back.body) : null;
		return mode === target
			? {
					result: "ok",
					via,
					mode,
					detail: "Switching may not update the terminal view.",
				}
			: {
					result: "failed",
					via,
					detail: "OpenCode did not take the new agent.",
					mode,
				};
	}

	// ---- commands ----

	/** Runs a `/name args` line (the `agents.command` acting op). */
	async run(agent: Agent, line: string): Promise<ControlResult> {
		const done = (r: Omit<ControlResult, "agentId">): ControlResult => ({
			agentId: agent.id,
			...r,
		});
		const cmd = parseCommand(line);
		if (!cmd)
			return done({
				result: "failed",
				via: "pulsar",
				detail: "A command is one line: / and a name, then its arguments.",
			});

		if (agent.harness === "pi" && this.sessions.extensionFor(agent.id)) {
			const r = await this.askExtension(agent, { kind: "command", line });
			return done(extensionOutcome(r, "command"));
		}

		if (agent.harness === "opencode" && agent.sessionId) {
			const api = await this.opencodeCommand(agent, cmd);
			if (api) return done(api);
		}

		let typed = line;
		if (agent.harness === "codex") {
			// Codex runs skills as `$name` mentions, not slash commands.
			const list = await this.catalogs.list(agent);
			const entry = list.commands.find((c) => c.name === cmd.name);
			if (entry?.skill) typed = `$${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
		}

		const pane = SCREENS.has(agent.harness)
			? await this.ports.pane(agent)
			: null;
		if (!pane) {
			const how = await this.commandPath(agent);
			return done({
				result: "unsupported",
				via: "tmux",
				detail: how.ok ? NOT_IN_TMUX : how.reason,
			});
		}
		return done(await this.type(agent, pane, typed));
	}

	/** Types `line` into an empty input box, checks it arrived, presses Enter. */
	private async type(
		agent: Agent,
		pane: string,
		line: string,
	): Promise<Omit<ControlResult, "agentId">> {
		const via = "tmux";
		const s = await this.screen(pane, agent.harness);
		if (!s?.recognized)
			return {
				result: "blocked",
				via,
				detail: "The terminal shows a dialog or menu, not the prompt.",
			};
		if (s.input !== "empty")
			return {
				result: "busy",
				via,
				detail: "Someone has unsent text in the agent's terminal.",
			};
		const sent = await this.ports.text(pane, line);
		if (!sent.ok) return { result: "failed", via, detail: sent.error };
		// The line must be in the input box before Enter sends it (compared
		// as plain text: the TUI may colour the name, wrap a long line).
		const flat = (t: string) => stripAnsi(t).replace(/\s+/g, "");
		const want = flat(line).slice(0, 80);
		let shown: Screen | null = null;
		for (let waited = 0; waited <= SETTLE_MS; waited += POLL_MS) {
			await this.ports.sleep(POLL_MS);
			const text = await this.ports.capture(pane);
			shown =
				text === null ? null : readScreen(agent.harness as ScreenHarness, text);
			if (!shown?.recognized) break;
			if (shown.input === "draft" && text !== null && flat(text).includes(want))
				break;
			shown = null;
		}
		if (!shown?.recognized || shown.input !== "draft") {
			// Take back what was typed, so the box is as it was.
			await this.ports.keys(pane, Array(line.length).fill("BSpace"));
			return {
				result: "failed",
				via,
				detail:
					"The typed command did not show in the terminal; Enter was not pressed and the text was taken back.",
			};
		}
		const enter = await this.ports.keys(pane, ["Enter"]);
		return enter.ok
			? { result: "ok", via }
			: { result: "failed", via, detail: enter.error };
	}

	/** OpenCode: server commands and skills through its API; null when the TUI must run it. */
	private async opencodeCommand(
		agent: Agent,
		cmd: { name: string; args: string },
	): Promise<Omit<ControlResult, "agentId"> | null> {
		const via = "opencode-api";
		const kinds = await this.catalogs.opencodeKinds();
		const session = `/api/session/${encodeURIComponent(agent.sessionId!)}`;
		const server = kinds.commands.includes(cmd.name);
		const skill = kinds.skills.get(cmd.name);
		if (!server && !skill) return null;
		const r = server
			? await this.ports.opencode("POST", `${session}/command`, {
					name: cmd.name,
					text: cmd.args,
				})
			: await this.ports.opencode("POST", `${session}/prompt`, {
					text: cmd.args || `Use the ${cmd.name} skill.`,
					skills: [{ id: skill }],
					delivery: "queue",
					resume: true,
				});
		return r.ok
			? { result: "ok", via }
			: { result: "failed", via, detail: r.error };
	}

	// ---- the pulsar extension (pi, omp) ----

	/** Asks the session's pulsar extension; null when none answers in time. */
	askExtension(
		agent: Agent,
		request: Record<string, unknown>,
	): Promise<Record<string, unknown> | null> {
		const ext = this.sessions.extensionFor(agent.id);
		if (!ext) return Promise.resolve(null);
		const requestId = randomBytes(8).toString("base64url");
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				resolve(null);
			}, EXTENSION_TIMEOUT_MS);
			timer.unref?.();
			this.pending.set(requestId, {
				agentId: agent.id,
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
			});
			ext.emit("control", { requestId, ...request });
		});
	}

	/** `control_result {requestId, ...}` from an extension. */
	answer(agentId: string, p: Record<string, unknown>) {
		const id = String(p.requestId ?? "");
		const waiting = this.pending.get(id);
		// Only the agent that was asked may answer.
		if (!waiting || waiting.agentId !== agentId) return { ok: false };
		this.pending.delete(id);
		waiting.resolve(p);
		return { ok: true };
	}
}

function opencodeAgentOf(body: unknown): string | null {
	const b = body as { data?: { agent?: unknown }; agent?: unknown } | null;
	const a = b?.data?.agent ?? b?.agent;
	return typeof a === "string" ? a : null;
}

function extensionOutcome(
	r: Record<string, unknown> | null,
	what: "mode" | "command",
): Omit<ControlResult, "agentId"> {
	const via = "extension";
	if (!r)
		return {
			result: "failed",
			via,
			detail:
				"The pulsar extension did not answer (update pulsar in the session?).",
		};
	const result = r.result;
	const ok = ["ok", "unsupported", "busy", "blocked", "failed"] as const;
	return {
		result: ok.includes(result as (typeof ok)[number])
			? (result as (typeof ok)[number])
			: "failed",
		via,
		...(typeof r.detail === "string" ? { detail: r.detail } : {}),
		...(what === "mode" && typeof r.mode === "string" ? { mode: r.mode } : {}),
	};
}

function modeParam(params: unknown): string {
	const m = (params as { mode?: unknown } | null)?.mode;
	if (typeof m !== "string" || !/^[A-Za-z]{1,40}$/.test(m))
		throw new RpcError("bad_request", "mode must be a mode id");
	return m;
}

function lineParam(params: unknown): string {
	const l = (params as { line?: unknown } | null)?.line;
	if (typeof l !== "string" || !parseCommand(l))
		throw new RpcError("bad_request", "line must be one `/name args` line");
	return l;
}
