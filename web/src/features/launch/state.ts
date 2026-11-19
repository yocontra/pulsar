import { ApiError, api, request } from "../../api/client.ts";
import type {
	LaunchHarness,
	LaunchOptions,
	LaunchParams,
	LaunchRefs,
	LaunchState,
} from "../../api/types.ts";
import { live } from "../../data/runtime.ts";
import { signal } from "../../lib/signals.ts";
import { hello } from "../../lib/store.ts";

/**
 * The launch feature's data: what a machine offers (folders, harnesses),
 * a repo's branches, and the launches this tab started, kept current from
 * the `launch` events (and `GET /launches/:id` after a reconnect).
 */

const enc = encodeURIComponent;

/** The machine as the routes name it: this one, or another by name. */
export const isLocal = (machine: string) =>
	!machine || machine === hello.peek()?.machine;

const machineKey = (machine: string) =>
	isLocal(machine) ? (hello.peek()?.machineId ?? "") : machine;

const optionsCache = new Map<
	string,
	{ at: number; p: Promise<LaunchOptions> }
>();

/** Folders and harnesses a machine offers (cached for a minute). */
export function launchOptions(machine: string): Promise<LaunchOptions> {
	const key = machineKey(machine);
	const hit = optionsCache.get(key);
	if (hit && Date.now() - hit.at < 60_000) return hit.p;
	const p = request<LaunchOptions>(`/machines/${enc(key)}/projects`);
	optionsCache.set(key, { at: Date.now(), p });
	p.catch(() => optionsCache.delete(key));
	return p;
}

export function launchRefs(machine: string, cwd: string): Promise<LaunchRefs> {
	return request<LaunchRefs>(
		`/machines/${enc(machineKey(machine))}/refs?cwd=${enc(cwd)}`,
	);
}

/** Launches this tab knows, by id. */
export const launches = signal<Map<string, LaunchState>>(new Map());

function put(s: LaunchState) {
	const prev = launches.peek().get(s.id);
	if (prev && prev.updatedAt > s.updatedAt) return;
	const m = new Map(launches.peek());
	m.set(s.id, s);
	launches.value = m;
}

let listening = false;
function listen() {
	if (listening) return;
	listening = true;
	live.on("launch", put);
	// After a reconnect, what was missed: read the open launches again.
	live.subscribeState(() => {
		if (live.state !== "open") return;
		for (const s of launches.peek().values())
			if (s.step !== "done" && s.step !== "failed")
				void request<LaunchState>(`/launches/${enc(s.id)}`)
					.then(put)
					.catch(() => {});
	});
}

/** A fresh id for one press of Send (a repeat starts nothing new). */
export function newNonce(): string {
	const b = new Uint8Array(12);
	crypto.getRandomValues(b);
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Starts an agent: Prove Human here, or that machine's own passkey check
 * (api.acting). `params` go out exactly as signed.
 */
export async function startLaunch(
	machine: string,
	params: LaunchParams,
): Promise<LaunchState> {
	listen();
	const remote = !isLocal(machine);
	const target = remote ? { machine } : {};
	const s = await api.acting(
		"agents.launch",
		target,
		params,
		(assertion) =>
			request<LaunchState>("/agents/launch", {
				method: "POST",
				body: {
					...(remote ? { machine } : {}),
					params,
					...(assertion !== undefined ? { assertion } : {}),
				},
			}),
		"act",
	);
	put(s);
	return s;
}

/** Plain words for an error from the launch routes. */
export function launchError(e: unknown, machine: string): string {
	if (e instanceof ApiError) {
		if (e.code === "unsupported" || e.status === 404 || e.status === 501)
			return e.code === "not_found"
				? e.message
				: `Pulsar on ${machine} can't start agents. Update it there.`;
		if (e.code === "unreachable")
			return `${machine} can't be reached right now.`;
		return e.message;
	}
	return (e as Error)?.message || "Something went wrong.";
}

export const HARNESS_LABEL: Record<LaunchHarness, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "pi",
	omp: "omp",
};

/** What a launch is doing, in a few words. */
export function stepText(s: LaunchState): string {
	const h = HARNESS_LABEL[s.harness];
	switch (s.step) {
		case "worktree":
			return "Setting up worktree…";
		case "starting":
			return `Starting ${h}…`;
		case "waiting":
			return `Waiting for ${h}…`;
		case "terminal":
			return "Waiting in the terminal";
		case "sending":
			return "Sending your message…";
		case "done":
			return "Started";
		case "failed":
			return s.error ?? "Couldn't start the agent";
	}
}
