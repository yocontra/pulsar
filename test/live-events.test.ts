/**
 * Notices that keep the app live with no refresh control: `usage` after a
 * scan stores new session lines, `git` after the periodic git or PR read
 * sees a change (every stream) or a watched worktree moves (a `git`
 * subscription), and `machines` when the pool's machines change.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../src/http/events.ts";
import type { Subscription } from "../src/http/wire.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { cleanupRepos, g, gitRepo } from "./git-repo.ts";
import { until } from "./helpers.ts";
import { claudeLine, rootsIn, write } from "./usage-fixtures.ts";

const OWNER = "me@x";
const NONE: Subscription = {
	expanded: [],
	window: null,
	session: null,
	query: null,
	results: null,
	receipts: [],
};

let dir: string;
let store: Store;
let service: PulsarService;
let hub: EventHub;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-live-"));
	store = new Store(join(dir, "pulsar.db"));
	service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		usage: { roots: () => rootsIn(dir) },
		changes: { pollMs: 50, debounceMs: 10 },
	});
	hub = new EventHub(service, { coalesceMs: 600_000 });
	hub.start();
});

afterEach(() => {
	hub.stop();
	service.stop();
	store.close();
	rmSync(dir, { recursive: true, force: true });
	cleanupRepos();
});

/** A stream's text as it arrives; `ready` already read. */
async function stream() {
	const reader = hub.open(OWNER, null).getReader();
	const dec = new TextDecoder();
	const first = dec.decode((await reader.read()).value);
	const streamId = /"streamId":"([^"]+)"/.exec(first)![1]!;
	let text = "";
	let pending: Promise<void> | null = null;
	const pump = () => {
		pending ??= reader.read().then((r) => {
			pending = null;
			if (r.value) text += dec.decode(r.value);
		});
		return pending;
	};
	return {
		streamId,
		/** Waits until the text holds `s` (or fails after `ms`). */
		async waitFor(s: string, ms = 3000) {
			const end = Date.now() + ms;
			while (!text.includes(s)) {
				const left = end - Date.now();
				if (left <= 0) throw new Error(`no "${s}" in:\n${text}`);
				await Promise.race([
					pump(),
					new Promise((r) => setTimeout(r, Math.min(left, 100))),
				]);
			}
		},
		/** What arrived within `ms`. */
		async drain(ms: number) {
			const end = Date.now() + ms;
			while (Date.now() < end)
				await Promise.race([
					pump(),
					new Promise((r) => setTimeout(r, end - Date.now())),
				]);
			return text;
		},
		clear() {
			text = "";
		},
		cancel: () => reader.cancel(),
	};
}

function count(event: "usage" | "git") {
	const seen: unknown[] = [];
	service.events.on(event, (d) => seen.push(d));
	return seen;
}

const agentIn = (cwd: string, sessionId: string) =>
	service.registry.upsert({
		harness: "pi",
		sessionId,
		pid: null,
		cwd,
		project: "demo",
		branch: "main",
		tags: [],
		meta: {},
		registered: false,
	});

describe("usage", () => {
	test("a scan that stores new lines sends one `usage` notice to every stream; an unchanged scan sends none", async () => {
		const usage = count("usage");
		const s = await stream();
		const file = join(dir, "claude", "projects", "-work-app", "s1.jsonl");
		write(file, [claudeLine({ id: "m1", t: Date.now() - 60_000 })]);
		await service.usage.scanner.scan();
		expect(usage).toHaveLength(1);
		await s.waitFor("event: usage");
		s.clear();
		// Nothing new: no notice.
		await service.usage.scanner.scan();
		expect(usage).toHaveLength(1);
		expect(await s.drain(150)).not.toContain("event: usage");
		// The file grows: one more.
		appendFileSync(file, `${claudeLine({ id: "m2", t: Date.now() })}\n`);
		await service.usage.scanner.scan();
		expect(usage).toHaveLength(2);
		await s.waitFor("event: usage");
		await s.cancel();
	});
});

describe("git", () => {
	test("the periodic git read sends `git` for an agent whose branch moved, and nothing when it did not", async () => {
		const d = gitRepo();
		const a = agentIn(d, "live-git-1");
		await service.registry.refreshGit();
		const git = count("git");
		const s = await stream();
		await service.registry.refreshGit();
		expect(git).toHaveLength(0);
		g(d, "switch", "-q", "-c", "feat");
		await service.registry.refreshGit();
		expect(git).toEqual([{ agentId: a.id }]);
		await s.waitFor(`event: git\n`);
		await s.waitFor(`"agentId":"${a.id}"`);
		await s.cancel();
	});

	test("the periodic PR read sends `git` when the agent's PR changes", async () => {
		const d = gitRepo();
		const a = agentIn(d, "live-git-2");
		await service.registry.refreshPrs();
		const git = count("git");
		const s = await stream();
		g(d, "update-ref", "refs/pull/7/head", "HEAD");
		await service.registry.refreshPrs();
		expect(git).toEqual([{ agentId: a.id }]);
		expect(service.registry.get(a.id)?.tags).toContain("pr:7");
		await s.waitFor(`"agentId":"${a.id}"`);
		await s.cancel();
	});

	test("a `git` subscription sends `git` when the watched worktree moves, not for the first read", async () => {
		const d = gitRepo();
		const a = agentIn(d, "live-git-3");
		const s = await stream();
		hub.setSubscription(s.streamId, OWNER, { ...NONE, git: [a.id] });
		// The first summary is the baseline: no notice.
		expect(await s.drain(300)).not.toContain("event: git");
		appendFileSync(join(d, "a.txt"), "four\n");
		await s.waitFor("event: git");
		await s.waitFor(`"agentId":"${a.id}"`);
		s.clear();
		// A new untracked file counts too.
		appendFileSync(join(d, "new.txt"), "x\n");
		await s.waitFor("event: git");
		s.clear();
		// Unsubscribed: the watch stops, and nothing more comes.
		hub.setSubscription(s.streamId, OWNER, NONE);
		appendFileSync(join(d, "a.txt"), "five\n");
		expect(await s.drain(300)).not.toContain("event: git");
		await s.cancel();
	});

	test("an unknown agent in a `git` subscription is ignored", async () => {
		const s = await stream();
		hub.setSubscription(s.streamId, OWNER, { ...NONE, git: ["nobody"] });
		expect(await s.drain(150)).not.toContain("event: git");
		await s.cancel();
	});
});

describe("machines", () => {
	test("a pool change sends `machines` only when the machines or their versions changed", async () => {
		const s = await stream();
		// A pool event with the same machines: nothing.
		service.events.emit("pool", { machineId: null });
		expect(await s.drain(100)).not.toContain("event: machines");
		// A new machine name (this one renamed): announced once.
		service.registry.setMachine("studio-2");
		service.events.emit("pool", { machineId: null });
		await until(async () => (await s.drain(20)).includes("event: machines"));
		await s.cancel();
	});
});
