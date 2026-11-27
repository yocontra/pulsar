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
import { PoolState } from "../src/federation/state.ts";
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
	hub = new EventHub(service, { coalesceMs: 600_000, gitPollMs: 50 });
	hub.start();
});

afterEach(() => {
	hub.stop();
	service.stop();
	store.close();
	rmSync(dir, { recursive: true, force: true });
	cleanupRepos();
});

/**
 * Counts the worktree summaries the service has read (a watch's first one
 * is its baseline).
 */
function summaries() {
	const changes = service.changes;
	const read = changes.summary.bind(changes);
	const n = { reads: 0 };
	changes.summary = async (...args: Parameters<typeof read>) => {
		const r = await read(...args);
		n.reads++;
		return r;
	};
	return n;
}

/** A stream's text as it arrives; `ready` already read. */
async function stream(lastEventId: string | null = null) {
	const reader = hub.open(OWNER, lastEventId).getReader();
	const dec = new TextDecoder();
	const first = dec.decode((await reader.read()).value);
	const streamId = /"streamId":"([^"]+)"/.exec(first)?.[1] ?? "";
	let lastId = /^id: (\S+)$/m.exec(first)?.[1] ?? null;
	let text = "";
	let pending: Promise<void> | null = null;
	const pump = () => {
		pending ??= reader.read().then((r) => {
			pending = null;
			if (!r.value) return;
			const chunk = dec.decode(r.value);
			text += chunk;
			for (const m of chunk.matchAll(/^id: (\S+)$/gm)) lastId = m[1]!;
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
		/** The last event id seen (for a resume). */
		lastId: () => lastId,
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

test("only the selected live chat receives a provider notice, with no reconnect replay", async () => {
	const target = agentIn(dir, "notice-target");
	const other = agentIn(dir, "other-session");
	const watching = await stream();
	const away = await stream();
	hub.setSubscription(watching.streamId, OWNER, {
		...NONE,
		session: target.id,
	});
	hub.setSubscription(away.streamId, OWNER, { ...NONE, session: other.id });
	const notice = {
		agentId: target.id,
		severity: "warning" as const,
		title: "Live notice",
	};
	service.events.emit("sessionNotice", notice);
	await watching.waitFor("Live notice");
	expect(await away.drain(30)).not.toContain("Live notice");
	const cursor = watching.lastId();
	await watching.cancel();
	service.events.emit("sessionNotice", { ...notice, title: "Expired notice" });
	const resumed = await stream(cursor);
	expect(resumed.streamId).toBe(watching.streamId);
	expect(await resumed.drain(30)).not.toContain("Expired notice");
	await Promise.all([resumed.cancel(), away.cancel()]);
});

test("a qualified local child receives its own notices", async () => {
	const parent = agentIn(dir, "child-notice");
	const child = `${parent.id}/sub:worker`;
	const qualified = `${service.machineId}/${child}`;
	const watching = await stream();
	hub.setSubscription(watching.streamId, OWNER, {
		...NONE,
		session: qualified,
	});
	service.events.emit("sessionNotice", {
		agentId: parent.id,
		title: "Parent only",
		severity: "info",
	});
	service.events.emit("sessionNotice", {
		agentId: child,
		title: "Child notice",
		severity: "info",
	});
	await watching.waitFor("Child notice");
	const events = await watching.drain(10);
	expect(events).toContain(`"agentId":"${qualified}"`);
	expect(events).not.toContain("Parent only");
	await watching.cancel();
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
		const n = summaries();
		const s = await stream();
		hub.setSubscription(s.streamId, OWNER, { ...NONE, git: [a.id] });
		// The first summary is the baseline: no notice.
		await until(() => n.reads >= 1, 5000);
		expect(await s.drain(150)).not.toContain("event: git");
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

	test("a stream that resumes after its git watch stopped is told to read git status again", async () => {
		const d = gitRepo();
		const a = agentIn(d, "live-git-4");
		const n = summaries();
		const s = await stream();
		hub.setSubscription(s.streamId, OWNER, { ...NONE, git: [a.id] });
		await until(() => n.reads >= 1, 5000);
		await s.drain(100);
		const last = s.lastId();
		expect(last).not.toBeNull();
		// The tab goes away: no connected stream wants the watch, so it stops.
		await s.cancel();
		await until(
			() =>
				(hub as unknown as { topics: Map<string, unknown> }).topics.size ===
					0 ||
				![
					...(
						hub as unknown as { topics: Map<string, { kind: string }> }
					).topics.values(),
				].some((t) => t.kind === "git"),
		);
		appendFileSync(join(d, "a.txt"), "four\n");
		// It comes back: a `git` notice, though the watch saw nothing meanwhile.
		const back = await stream(last);
		await back.waitFor("event: git");
		await back.waitFor(`"agentId":"${a.id}"`);
		await back.cancel();
	});

	test("an unknown agent in a `git` subscription is ignored", async () => {
		const s = await stream();
		hub.setSubscription(s.streamId, OWNER, { ...NONE, git: ["nobody"] });
		expect(await s.drain(150)).not.toContain("event: git");
		await s.cancel();
	});
});

describe("machines", () => {
	test("a peer that comes back on a new Pulsar version is a pool change", () => {
		const state = new PoolState();
		const changes: (string | null)[] = [];
		state.onChange = (id) => changes.push(id);
		const node = {
			nodeId: "n",
			name: "b",
			dnsName: "b.x.ts.net",
			userId: "u",
			login: "me",
			tags: [],
			online: true,
		};
		const hello = (v: string) => ({
			fedProtocol: [1, 1] as [number, number],
			features: [],
			pulsarVersion: v,
			machineId: "mb",
			name: "b",
		});
		state.upsert(node, hello("2.0.0"), 1);
		state.upsert(node, hello("2.0.0"), 1);
		expect(changes).toEqual([]);
		state.upsert(node, hello("2.1.0"), 1);
		expect(changes).toEqual(["mb"]);
	});

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
