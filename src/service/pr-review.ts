import type {
	GitCommentParams,
	GitPrReview,
	GitReplyParams,
	GitResolveParams,
	GitReviewParams,
	GitReviewPatch,
} from "../http/wire.ts";
import {
	addComment,
	NODE_ID,
	prReview,
	prReviewFile,
	replyThread,
	resolveThread,
	SHA,
	submitReview,
} from "../pr-review.ts";
import { RpcError } from "../rpc.ts";
import type { Agent } from "../types.ts";
import type { Acting } from "./acting.ts";
import { OPERATOR_ID, type Principal } from "./caller.ts";
import type { PoolView } from "./pool.ts";
import type { Registry } from "./registry.ts";

/**
 * PR review in the app (src/pr-review.ts): the review read and one file's
 * patch (the diff viewer's rule, `transcript.read`; remote agents through
 * their home node, `git.review` frames), and the acting ops `git.comment`,
 * `git.reply`, `git.resolve`, `git.review` (Prove Human, audited, verified
 * by the home node; src/service/acting.ts). They run whether or not the
 * agent works: they change GitHub, not its worktree.
 */

const bad = (msg: string): never => {
	throw new RpcError("bad_request", msg);
};

function plain(v: unknown, keys: readonly string[], what: string) {
	if (!v || typeof v !== "object" || Array.isArray(v))
		bad(`${what}: expected an object`);
	for (const k of Object.keys(v as object))
		if (!keys.includes(k)) bad(`${what}: unknown field ${k}`);
	return v as Record<string, unknown>;
}

function int(o: Record<string, unknown>, k: string): number {
	const v = o[k];
	if (!Number.isSafeInteger(v) || (v as number) < 1)
		bad(`${k}: expected a positive whole number`);
	return v as number;
}

function str(o: Record<string, unknown>, k: string, max: number): string {
	const v = o[k];
	if (typeof v !== "string") bad(`${k}: expected text`);
	const s = v as string;
	if (s.length > max) bad(`${k}: at most ${max} characters`);
	if (s.includes("\0")) bad(`${k}: no NUL characters`);
	return s;
}

const body = (o: Record<string, unknown>, required: boolean) => {
	const b = str(o, "body", 20_000);
	if (required && !b.trim()) bad("body: write something");
	return b;
};

const thread = (o: Record<string, unknown>) => {
	const t = str(o, "thread", 200);
	if (!NODE_ID.test(t)) bad("thread: expected a thread id");
	return t;
};

/** Each op's params, checked exactly as sent (a remote proof covers these bytes). */
export function commentParams(v: unknown): GitCommentParams {
	const o = plain(
		v,
		["number", "head", "path", "line", "side", "body"],
		"comment",
	);
	const head = str(o, "head", 40);
	if (!SHA.test(head)) bad("head: expected a commit id");
	const path = str(o, "path", 4096);
	if (!path) bad("path: expected a path");
	if (o.side !== "LEFT" && o.side !== "RIGHT") bad("side: LEFT or RIGHT");
	return {
		number: int(o, "number"),
		head,
		path,
		line: int(o, "line"),
		side: o.side as "LEFT" | "RIGHT",
		body: body(o, true),
	};
}

export function replyParams(v: unknown): GitReplyParams {
	const o = plain(v, ["number", "thread", "body"], "reply");
	return { number: int(o, "number"), thread: thread(o), body: body(o, true) };
}

export function resolveParams(v: unknown): GitResolveParams {
	const o = plain(v, ["number", "thread", "resolved"], "resolve");
	if (typeof o.resolved !== "boolean") bad("resolved: expected true or false");
	return {
		number: int(o, "number"),
		thread: thread(o),
		resolved: o.resolved as boolean,
	};
}

export function reviewParams(v: unknown): GitReviewParams {
	const o = plain(v, ["number", "event", "body"], "review");
	const event = o.event;
	if (event !== "comment" && event !== "approve" && event !== "request_changes")
		bad("event: comment, approve or request_changes");
	// An approval may go without words; a comment or a change request may not.
	const b = body(o, event !== "approve");
	return {
		number: int(o, "number"),
		event: event as GitReviewParams["event"],
		body: b,
	};
}

interface PrReviewOptions {
	registry: Registry;
	acting: Acting;
	pool: () => PoolView | null;
}

export class PrReviewOps {
	private o: PrReviewOptions;
	private offs: (() => void)[];

	constructor(o: PrReviewOptions) {
		this.o = o;
		this.offs = [
			o.acting.register("git.comment", async ({ agent, params }) =>
				addComment(this.local(agent!).cwd, commentParams(params)),
			),
			o.acting.register("git.reply", async ({ agent, params }) =>
				replyThread(this.local(agent!).cwd, replyParams(params)),
			),
			o.acting.register("git.resolve", async ({ agent, params }) =>
				resolveThread(this.local(agent!).cwd, resolveParams(params)),
			),
			o.acting.register("git.review", async ({ agent, params }) =>
				submitReview(this.local(agent!).cwd, reviewParams(params)),
			),
		];
	}

	/** Removes the acting handlers (tests that stand in their own). */
	off() {
		for (const f of this.offs.splice(0)) f();
	}

	private local(id: string): Agent {
		const a =
			this.o.registry.get(id) ??
			(id === OPERATOR_ID ? this.o.registry.operator() : undefined);
		if (!a) throw new RpcError("not_found", `no agent ${id}`);
		return a;
	}

	/** A remote agent's address (another machine), or null for a local one. */
	private remote(id: string): string | null {
		if (this.o.registry.get(id) || id === OPERATOR_ID) return null;
		if (!id.includes("/") || !this.o.pool())
			throw new RpcError("not_found", `no agent ${id}`);
		return id;
	}

	async review(
		id: string,
		as?: Principal,
		fresh = false,
	): Promise<GitPrReview> {
		const address = this.remote(id);
		if (!address) return prReview(id, this.local(id).cwd, fresh);
		const r = await this.read(address, null, as);
		if (!r)
			return {
				agent: id,
				pr: null,
				reason: "gh_error",
				message: "That machine runs an older Pulsar.",
				head: null,
				body: "",
				author: null,
				ownPr: false,
				checks: [],
				review: null,
				reviews: [],
				files: [],
				truncated: false,
				threads: [],
			};
		return { ...(r as GitPrReview), agent: id };
	}

	async file(
		id: string,
		path: string,
		as?: Principal,
	): Promise<GitReviewPatch> {
		const address = this.remote(id);
		if (!address) return prReviewFile(id, this.local(id).cwd, path);
		const r = await this.read(address, path, as);
		if (!r)
			throw new RpcError("unsupported", "That machine runs an older Pulsar.");
		return { ...(r as GitReviewPatch), agent: id };
	}

	/** A read on the home node; null when it is too old to know it. */
	private async read(
		address: string,
		path: string | null,
		as?: Principal,
	): Promise<unknown> {
		const pool = this.o.pool();
		if (!pool?.gitReview) return null;
		try {
			return (await pool.gitReview(address, path, as)) ?? null;
		} catch (e) {
			if (e instanceof RpcError && e.code === "unsupported") return null;
			throw e;
		}
	}
}
