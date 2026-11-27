import type {
	LaunchHarness,
	LaunchOptions,
	LaunchParams,
	LaunchRefs,
	LaunchState,
	LaunchStep,
} from "../../src/http/wire.ts";
import type { RpcError } from "../../src/rpc.ts";
import { parseLaunchParams } from "../../src/service/launch.ts";
import { agents, machineByName, makeAgent } from "./data.ts";

/**
 * The mock's launches (features/launch, src/service/launch.ts): the same
 * routes and params checks, with steps on timers instead of tmux. A folder
 * with `trust` in it stops at a folder-trust dialog until
 * `POST /__mock/launch/answer`; one with `fail` fails while starting. Once
 * up, the agent joins the pool like any other.
 */

export interface LaunchCtx {
	/** Throws unless the passkey session (here) or that machine's assertion checks out. */
	requireActing: (
		req: Request,
		op: string,
		target: { machine?: string },
		params: unknown,
		assertion: unknown,
	) => Promise<void>;
	/** Sends a `launch` event to every stream. */
	broadcast: (s: LaunchState) => void;
	local: string;
	error: (status: number, code: string, message: string) => Error;
	/** Mock speed: each step's time (ms). */
	stepMs: number;
}

const HARNESSES: { id: LaunchHarness; label: string }[] = [
	{ id: "claude", label: "Claude Code" },
	{ id: "codex", label: "Codex" },
	{ id: "opencode", label: "OpenCode" },
	{ id: "pi", label: "pi" },
	{ id: "omp", label: "omp" },
];

const runs = new Map<string, { state: LaunchState; params: LaunchParams }>();
const nonces = new Map<string, string>();
let seq = 0;

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

function home(machine: string) {
	return machine === "studio" ? "/Users/you" : `/home/${machine}`;
}

function options(machine: string): LaunchOptions {
	const h = home(machine);
	const names = new Set<string>();
	for (const a of agents)
		if (a.machine === machine && a.project) names.add(a.project);
	const projects = [...names].sort().map((name, i) => ({
		path: `${h}/Projects/${name}`,
		name,
		agents: agents.filter((a) => a.machine === machine && a.project === name)
			.length,
		lastSeen: Date.now() - i * 60_000,
	}));
	return {
		machineId: machine,
		machine,
		home: h,
		projects,
		checked: true,
		harnesses: HARNESSES.map((x) => ({
			...x,
			// The mock's machines lack omp, to show the mark.
			installed: x.id !== "omp",
			...(x.id === "codex"
				? {
						mode: "acp" as const,
						settings: {
							model: [
								{ value: `${machine}-model`, label: `Model on ${machine}` },
							],
							effort: [{ value: "high", label: "High" }],
						},
					}
				: {}),
		})),
	};
}

function refs(cwd: string): LaunchRefs {
	if (cwd.includes("plain-folder"))
		return { root: null, current: null, branches: [] };
	return {
		root: cwd,
		current: "main",
		branches: [
			{ name: "main", remote: false },
			{ name: "release/2.0", remote: false },
			{ name: "fix/flaky-login", remote: false },
			{ name: "origin/main", remote: true },
		],
	};
}

function set(id: string, patch: Partial<LaunchState>, ctx: LaunchCtx) {
	const r = runs.get(id);
	if (!r || r.state.step === "done" || r.state.step === "failed") return;
	r.state = { ...r.state, ...patch, updatedAt: Date.now() };
	ctx.broadcast(r.state);
}

function advance(id: string, ctx: LaunchCtx) {
	const r = runs.get(id);
	if (!r) return;
	const s = r.state;
	const next = (step: LaunchStep, patch: Partial<LaunchState> = {}) =>
		setTimeout(() => {
			set(id, { step, ...patch }, ctx);
			advance(id, ctx);
		}, ctx.stepMs);
	switch (s.step) {
		case "worktree":
			return next("starting");
		case "starting":
			if (
				(r.params.model && r.params.model !== `${s.machine}-model`) ||
				(r.params.effort && r.params.effort !== "high")
			)
				return next("failed", {
					error:
						"The provider refused first-turn settings; your message was not sent.",
				});
			if (r.params.cwd.includes("fail"))
				return next("failed", {
					error: `${HARNESSES.find((h) => h.id === s.harness)?.label} exited: command not found`,
				});
			return next("waiting");
		case "waiting": {
			if (r.params.cwd.includes("trust") && !s.detail?.startsWith("answered"))
				return next("terminal", {
					detail: "Waiting in the terminal: folder trust",
				});
			const m = machineByName.get(s.machine)!;
			const project = baseName(s.cwd);
			const a = makeAgent(m, project, {
				harness: s.harness,
				name: r.params.name ?? `${s.harness}@${project}`,
				status: "idle",
				lastActive: Date.now(),
				statusSince: Date.now(),
				branch: s.branch ?? "main",
				activity: null,
				pr: null,
				worktree: null,
			});
			set(id, { agentId: a.id, detail: null }, ctx);
			if (r.params.prompt) return next("sending");
			return next("done");
		}
		case "sending":
			return next("done", { sent: true });
		default:
			return;
	}
}

/** Handles a launch route; null when the request is not one. */
export async function launchRoute(
	req: Request,
	url: URL,
	seg: string[],
	ctx: LaunchCtx,
): Promise<unknown | null> {
	const GET = req.method === "GET";
	const POST = req.method === "POST";
	const machineOf = (m: string) => {
		const name = m === "local" ? ctx.local : m;
		if (!machineByName.get(name))
			throw ctx.error(404, "not_found", `no machine ${m}`);
		return name;
	};
	if (GET && seg[0] === "machines" && seg[2] === "projects" && seg.length === 3)
		return options(machineOf(seg[1]!));
	if (GET && seg[0] === "machines" && seg[2] === "refs" && seg.length === 3) {
		machineOf(seg[1]!);
		const cwd = url.searchParams.get("cwd");
		if (!cwd) throw ctx.error(400, "bad_request", "cwd: required");
		return refs(cwd);
	}
	if (GET && seg[0] === "launches" && seg.length >= 2) {
		const r = runs.get(seg.slice(1).join("/"));
		if (!r) throw ctx.error(404, "not_found", "no such launch");
		return r.state;
	}
	if (POST && url.pathname.endsWith("/__mock/launch/answer")) {
		for (const r of runs.values())
			if (r.state.step === "terminal") {
				set(r.state.id, { step: "waiting", detail: "answered" }, ctx);
				advance(r.state.id, ctx);
			}
		return { ok: true };
	}
	if (POST && seg[0] === "agents" && seg[1] === "launch" && seg.length === 2) {
		const b = (await req.json()) as {
			machine?: string;
			params?: unknown;
			assertion?: unknown;
		};
		const machine = b.machine ? machineOf(b.machine) : ctx.local;
		await ctx.requireActing(
			req,
			"agents.launch",
			machine === ctx.local ? {} : { machine },
			b.params ?? null,
			b.assertion,
		);
		let p: LaunchParams;
		try {
			p = parseLaunchParams(b.params);
		} catch (e) {
			throw ctx.error(
				400,
				(e as RpcError).code ?? "bad_request",
				(e as Error).message,
			);
		}
		const held = nonces.get(p.nonce);
		if (held && runs.has(held)) return runs.get(held)!.state;
		if (p.cwd.includes("missing"))
			throw ctx.error(404, "not_found", `no folder ${p.cwd} on ${machine}`);
		const local = `l${(seq++).toString(36)}`;
		const id = machine === ctx.local ? local : `${machine}/${local}`;
		const cwd = p.cwd.startsWith("~") ? home(machine) + p.cwd.slice(1) : p.cwd;
		const branch =
			p.workspace === "worktree"
				? (p.branch ?? `pulsar/${p.harness}-${local}`)
				: null;
		const now = Date.now();
		const state: LaunchState = {
			id,
			machineId: machine,
			machine,
			harness: p.harness,
			cwd: branch ? `${cwd}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}` : cwd,
			branch,
			step: branch ? "worktree" : "starting",
			detail: null,
			error: null,
			agentId: null,
			session: `pulsar-${local}`,
			prompt: !!p.prompt,
			sent: false,
			startedAt: now,
			updatedAt: now,
		};
		runs.set(id, { state, params: p });
		nonces.set(p.nonce, id);
		ctx.broadcast(state);
		advance(id, ctx);
		return state;
	}
	return null;
}

/** Tests: forget every launch. */
export function resetLaunches() {
	runs.clear();
	nonces.clear();
}
