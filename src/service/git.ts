import {
	commit,
	createPr,
	gitStatus,
	prDetails,
	push,
} from "../git-actions.ts";
import type {
	GitCommitParams,
	GitPrDetails,
	GitPrParams,
	GitPushParams,
	GitStatus,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Agent } from "../types.ts";
import type { Acting } from "./acting.ts";
import { OPERATOR_ID, type Principal } from "./caller.ts";
import type { PoolView } from "./pool.ts";
import type { Registry } from "./registry.ts";

/**
 * The app's git actions on an agent's worktree: status and PR reads (the
 * same rule as the diff viewer, `transcript.read`; remote agents through
 * their home node) and the acting ops `git.commit`, `git.push`, `git.pr`
 * (Prove Human, audited, verified by the home node; src/service/acting.ts).
 * The git work itself is src/git-actions.ts.
 */

type Bad = (msg: string) => never;
const bad: Bad = (msg) => {
	throw new RpcError("bad_request", msg);
};

function plain(v: unknown, keys: readonly string[], what: string) {
	if (!v || typeof v !== "object" || Array.isArray(v))
		bad(`${what}: expected an object`);
	for (const k of Object.keys(v as object))
		if (!keys.includes(k)) bad(`${what}: unknown field ${k}`);
	return v as Record<string, unknown>;
}

const flag = (o: Record<string, unknown>, k: string) => {
	if (o[k] !== undefined && typeof o[k] !== "boolean")
		bad(`${k}: expected true or false`);
	return o[k] === true;
};

function text(
	o: Record<string, unknown>,
	k: string,
	max: number,
	required = false,
): string | undefined {
	const v = o[k];
	if (v === undefined && !required) return undefined;
	if (typeof v !== "string") bad(`${k}: expected text`);
	if (v.length > max) bad(`${k}: at most ${max} characters`);
	if (v.includes("\0")) bad(`${k}: no NUL characters`);
	return v;
}

/**
 * The params of each op, checked exactly as sent (no defaults, nothing
 * dropped): a remote proof covers these bytes, and a relayed handler gets
 * them from a frame.
 */
export function commitParams(v: unknown): GitCommitParams {
	const o = plain(
		v,
		["files", "message", "newBranch", "confirmBusy", "confirmDefault"],
		"commit",
	);
	if (!Array.isArray(o.files) || o.files.length === 0)
		bad("files: pick at least one file");
	if (o.files.length > 5000) bad("files: at most 5000");
	for (const f of o.files)
		if (typeof f !== "string" || !f || f.length > 4096 || f.includes("\0"))
			bad("files: expected paths");
	const message = text(o, "message", 20_000, true)!;
	if (!message.trim()) bad("message: write a commit message");
	const newBranch = text(o, "newBranch", 200);
	if (newBranch !== undefined && !newBranch.trim())
		bad("newBranch: name the branch");
	return {
		files: o.files as string[],
		message,
		...(newBranch !== undefined ? { newBranch } : {}),
		confirmBusy: flag(o, "confirmBusy"),
		confirmDefault: flag(o, "confirmDefault"),
	};
}

export function pushParams(v: unknown): GitPushParams {
	const o = plain(v, ["confirmBusy", "confirmDefault"], "push");
	return {
		confirmBusy: flag(o, "confirmBusy"),
		confirmDefault: flag(o, "confirmDefault"),
	};
}

export function prParams(v: unknown): GitPrParams {
	const o = plain(v, ["title", "body", "draft"], "pr");
	const title = text(o, "title", 300);
	const body = text(o, "body", 60_000);
	return {
		...(title !== undefined ? { title } : {}),
		...(body !== undefined ? { body } : {}),
		draft: flag(o, "draft"),
	};
}

interface GitOpsOptions {
	registry: Registry;
	acting: Acting;
	pool: () => PoolView | null;
}

export class GitOps {
	private o: GitOpsOptions;
	private offs: (() => void)[];

	constructor(o: GitOpsOptions) {
		this.o = o;
		this.offs = this.register(o.acting);
	}

	/** Removes the acting handlers (tests that stand in their own). */
	off() {
		for (const f of this.offs.splice(0)) f();
	}

	private register(acting: Acting): (() => void)[] {
		return [
			acting.register("git.commit", async ({ agent, params }) => {
				const p = commitParams(params);
				const a = this.working(agent!, p.confirmBusy);
				return commit(a.cwd, p);
			}),
			acting.register("git.push", async ({ agent, params }) => {
				const p = pushParams(params);
				const a = this.working(agent!, p.confirmBusy);
				return push(a.cwd, p);
			}),
			acting.register("git.pr", async ({ agent, params }) => {
				const p = prParams(params);
				return createPr(this.local(agent!).cwd, p);
			}),
		];
	}

	private local(id: string): Agent {
		// The operator (a session header in the app) has no folder: no_cwd.
		const a =
			this.o.registry.get(id) ??
			(id === OPERATOR_ID ? this.o.registry.operator() : undefined);
		if (!a) throw new RpcError("not_found", `no agent ${id}`);
		return a;
	}

	/** The agent, unless it is mid-turn and the operator did not confirm. */
	private working(id: string, confirmed: boolean | undefined): Agent {
		const a = this.local(id);
		if (!confirmed && (a.status === "busy" || this.o.registry.needsYou(a.id)))
			throw new RpcError(
				"confirm_busy",
				`${a.name} is working. Confirm to go ahead anyway.`,
			);
		return a;
	}

	/** A remote agent's address (another machine), or null for a local one. */
	private remote(id: string): string | null {
		if (this.o.registry.get(id) || id === OPERATOR_ID) return null;
		if (!id.includes("/") || !this.o.pool())
			throw new RpcError("not_found", `no agent ${id}`);
		return id;
	}

	async status(id: string, as?: Principal): Promise<GitStatus> {
		const address = this.remote(id);
		if (!address) return gitStatus(id, this.local(id).cwd);
		const r = await this.read(address, "status", as);
		if (!r) return { ...unsupportedStatus(), agent: id };
		return { ...(r as GitStatus), agent: id };
	}

	async pr(id: string, as?: Principal): Promise<GitPrDetails> {
		const address = this.remote(id);
		if (!address) return prDetails(id, this.local(id).cwd);
		const r = await this.read(address, "pr", as);
		if (!r)
			return {
				agent: id,
				pr: null,
				reason: "gh_error",
				message: "That machine runs an older Pulsar.",
				checks: [],
				review: null,
				comments: [],
			};
		return { ...(r as GitPrDetails), agent: id };
	}

	/** A read on the home node; null when it is too old to know git reads. */
	private async read(
		address: string,
		what: "status" | "pr",
		as?: Principal,
	): Promise<unknown> {
		const pool = this.o.pool();
		if (!pool?.gitRead) return null;
		try {
			return await pool.gitRead(address, what, as);
		} catch (e) {
			if (e instanceof RpcError && e.code === "unsupported") return null;
			throw e;
		}
	}
}

function unsupportedStatus(): Omit<GitStatus, "agent"> {
	return {
		available: false,
		reason: "unsupported",
		root: null,
		branch: null,
		head: null,
		defaultBranch: null,
		onDefault: false,
		remote: null,
		upstream: null,
		pushTo: null,
		upstreamGone: false,
		ahead: 0,
		behind: 0,
		dirty: 0,
		conflicted: 0,
		operation: null,
		github: false,
		gh: null,
		pr: null,
	};
}
