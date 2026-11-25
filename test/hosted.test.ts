import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteHosted } from "../src/federation/hosted.ts";
import { HostedCatalog, hostedReport } from "../src/hosted/catalog.ts";
import {
	decodeHosted,
	hostedWriter,
	readHosted,
} from "../src/hosted/providers.ts";
import type {
	HostedObservation,
	HostedProvider,
	HostedWrite,
} from "../src/hosted/wire.ts";
import { HostedWrites } from "../src/hosted/writes.ts";
import type { PoolMachine } from "../src/service/pool.ts";
import { Store } from "../src/store.ts";

const copilot = [
	{
		id: "abc-123",
		name: "Original task",
		state: "queued",
		updatedAt: "2026-11-23T00:00:00Z",
		pullRequestUrl: "https://github.com/example/repo/pull/1",
	},
];
const codex = {
	tasks: [
		{
			id: "abc-123",
			title: "Cloud task",
			status: "Ready",
			url: "https://chatgpt.com/codex/tasks/abc-123",
		},
	],
};
const cursor = {
	items: [
		{
			id: "bc-abc-123",
			name: "Cursor task",
			status: "IDLE",
			url: "https://cursor.com/agents/bc-abc-123",
		},
	],
};

test("provider rows use durable IDs and normalize links without credentials", () => {
	const tasks = decodeHosted("copilot", copilot)!;
	expect(tasks[0]).toMatchObject({
		id: "abc-123",
		url: "https://github.com/example/repo/pull/1/agent-sessions/abc-123",
	});
	expect(decodeHosted("codex", codex)?.[0]).toMatchObject({
		id: "abc-123",
		url: "https://chatgpt.com/codex/cloud/tasks/abc-123",
	});
	expect(decodeHosted("cursor", cursor)?.[0]).toMatchObject({
		id: "bc-abc-123",
		status: "IDLE",
	});
	expect(decodeHosted("codex", { tasks: [] })).toEqual([]);
	expect(decodeHosted("copilot", [{ id: "../invalid" }])).toBeNull();
	expect(
		decodeHosted("cursor", {
			items: [{ id: "bc-abc", url: "https://secret@cursor.com/agents/bc-abc" }],
		})?.[0]?.url,
	).toBeNull();
});

test("federation deduplicates by provider and ID and preserves last-known offline results", async () => {
	let link: PoolMachine["link"] = "tailnet";
	const user = { kind: "human" as const, node: "phone", login: "operator" };
	const tasks = decodeHosted("copilot", copilot)!;
	const seen: HostedObservation = {
		provider: "copilot",
		state: "ready",
		observedAt: Date.now(),
		detail: null,
		tasks,
	};
	const remote = new RemoteHosted({
		machines: () => [{ machineId: "remote", name: "Remote", link, agents: 0 }],
		act: async (_, action, as) => {
			expect(action).toEqual({ op: "hosted.list" });
			expect(as).toEqual(user);
			return {
				ok: true,
				providers: [
					seen,
					{ ...seen, provider: "codex", tasks: decodeHosted("codex", codex)! },
				],
			};
		},
	});
	const local = {
		machineId: "local",
		name: "Local",
		state: "reachable" as const,
		providers: [{ ...seen, tasks: [{ ...tasks[0]!, title: "Current task" }] }],
	};
	expect((await remote.observe(user))[0]?.state).toBe("reachable");
	link = "asleep";
	const report = hostedReport([...(await remote.observe(user)), local]);
	expect(report.tasks).toHaveLength(2);
	expect(report.tasks.find((t) => t.provider === "copilot")).toMatchObject({
		id: "abc-123",
		title: "Current task",
		sources: [
			{ machineId: "remote", state: "offline" },
			{ machineId: "local", state: "reachable" },
		],
	});
	expect(report.tasks.find((t) => t.provider === "codex")?.sources).toEqual([
		{ machineId: "remote", state: "offline" },
	]);
	expect(
		(await remote.observe({ ...user, login: "new-owner" }))[0]?.providers,
	).toEqual([]);
});

const create: HostedWrite = {
	provider: "copilot",
	nonce: crypto.randomUUID(),
	action: "create",
	repo: "example/repo",
	prompt: "A synthetic task",
	ref: "main",
};

test("an ambiguous action is protected across retries, new request IDs, and restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulsar-hosted-test-"));
	const file = join(dir, "db");
	let store = new Store(file);
	let calls = 0;
	const writer: typeof hostedWriter = async () => async () => {
		calls++;
		throw new Error("connection dropped after submit");
	};
	try {
		const writes = new HostedWrites(store, writer);
		expect(await writes.run("owner", create)).toEqual({ state: "unknown" });
		store.close();
		store = new Store(file);
		const restarted = new HostedWrites(store, writer);
		expect(await restarted.run("owner", create)).toEqual({ state: "unknown" });
		expect(
			await restarted.run("Owner", {
				...create,
				repo: "EXAMPLE/Repo",
				nonce: crypto.randomUUID(),
			}),
		).toEqual({ state: "unknown" });
		expect(calls).toBe(1);
		await expect(
			restarted.run("owner", { ...create, prompt: "Another prompt" }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(
			store
				.metaByPrefix("hosted:")
				.some((row) => row.value.includes(create.prompt)),
		).toBe(false);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a concurrent retry consults the receipt while one provider request is in flight", async () => {
	const store = new Store(":memory:");
	const done = Promise.withResolvers<{ state: "accepted"; id: string }>();
	const started = Promise.withResolvers<void>();
	let calls = 0;
	const writes = new HostedWrites(store, async () => async () => {
		calls++;
		started.resolve();
		return done.promise;
	});
	try {
		const first = writes.run("owner", create);
		await started.promise;
		expect(await writes.run("owner", create)).toEqual({ state: "unknown" });
		const accepted = { state: "accepted", id: "abc-123" } as const;
		done.resolve(accepted);
		expect(await first).toEqual(accepted);
		expect(await writes.run("owner", create)).toEqual(accepted);
		expect(calls).toBe(1);
	} finally {
		store.close();
	}
});

test("receipt checks never submit work and duplicate requests follow the original receipt", async () => {
	const store = new Store(":memory:");
	let credentials = 0;
	const accepted = { state: "accepted", id: "abc-123" } as const;
	const done = Promise.withResolvers<typeof accepted>();
	const started = Promise.withResolvers<void>();
	const actions: string[] = [];
	const writes = new HostedWrites(
		store,
		async () => {
			credentials++;
			return async () => {
				started.resolve();
				return done.promise;
			};
		},
		(p) => actions.push(p),
	);
	const check = (nonce: string, owner = "owner") =>
		writes.run(owner, { action: "receipt", nonce });
	try {
		expect(await check(create.nonce)).toEqual({ state: "not-found" });
		expect(credentials).toBe(0);
		const first = writes.run("owner", create);
		await started.promise;
		const duplicate = { ...create, nonce: crypto.randomUUID() };
		expect(await writes.run("owner", duplicate)).toEqual({ state: "unknown" });
		expect(await check(duplicate.nonce)).toEqual({ state: "unknown" });
		done.resolve(accepted);
		await first;
		expect(await check(duplicate.nonce)).toEqual(accepted);
		expect(await check(create.nonce, "other")).toEqual({ state: "not-found" });
		expect(credentials).toBe(2);
		expect(actions).toEqual(["copilot"]);
	} finally {
		store.close();
	}
});

test("accepted writes invalidate one provider even with a catalog read in flight", async () => {
	const calls: HostedProvider[] = [];
	const older = Promise.withResolvers<Awaited<ReturnType<typeof readHosted>>>();
	const tasks = decodeHosted("copilot", copilot)!;
	const catalog = new HostedCatalog(async (p) => {
		calls.push(p);
		if (p === "copilot" && calls.length === 1) return older.promise;
		return { state: "ready", tasks: p === "copilot" ? tasks : [] };
	});
	const first = catalog.observe();
	catalog.invalidate("copilot");
	const second = await catalog.observe();
	expect(second[0]?.tasks).toEqual(tasks);
	older.resolve({ state: "ready", tasks: [] });
	await first;
	expect((await catalog.observe())[0]?.tasks).toEqual(tasks);
	expect(calls).toEqual(["copilot", "codex", "cursor", "copilot"]);
	await Promise.all([catalog.observe(true), catalog.observe(true)]);
	expect(calls.slice(4)).toEqual(["copilot", "codex", "cursor"]);
});

test("authenticated CLI adapters pass the prompt on stdin and parse provider receipts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulsar-hosted-cli-test-"));
	const path = process.env.PATH;
	process.env.PATH = dir;
	try {
		await writeFile(
			join(dir, "gh"),
			`#!/bin/sh
case "$2" in
  list) printf '%s\\n' '${JSON.stringify(copilot)}';;
  create)
    IFS= read -r prompt
    [ "$prompt" = "A synthetic task" ] || exit 3
    [ "$*" = "agent-task create -R github.com/example/repo -F - --base main" ] || exit 4
    printf '%s\\n' 'https://github.com/example/repo/pull/1/agent-sessions/abc-123';;
esac
`,
			{ mode: 0o700 },
		);
		await writeFile(
			join(dir, "codex"),
			`#!/bin/sh
case "$2" in
  list) printf '%s\\n' '${JSON.stringify(codex)}';;
  exec)
    IFS= read -r prompt
    [ "$prompt" = "A synthetic task" ] || exit 3
    [ "$*" = "cloud exec --env env-1 --branch main -" ] || exit 4
    printf '%s\\n' 'https://chatgpt.com/codex/tasks/abc-123';;
esac
`,
			{ mode: 0o700 },
		);
		expect(await readHosted("copilot")).toMatchObject({
			state: "ready",
			tasks: [{ id: "abc-123" }],
		});
		expect(await (await hostedWriter("copilot"))!(create)).toMatchObject({
			state: "accepted",
			id: "abc-123",
		});
		expect(await readHosted("codex")).toMatchObject({
			state: "ready",
			tasks: [{ id: "abc-123" }],
		});
		expect(
			await (await hostedWriter("codex"))!({
				provider: "codex",
				action: "create",
				environment: "env-1",
				ref: "main",
				prompt: create.prompt,
				nonce: crypto.randomUUID(),
			}),
		).toMatchObject({
			state: "accepted",
			id: "abc-123",
			url: "https://chatgpt.com/codex/cloud/tasks/abc-123",
		});
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		await rm(dir, { recursive: true, force: true });
	}
});

test("Cursor create and follow-up send only to the fixed provider origin", async () => {
	const prior = process.env.CURSOR_API_KEY;
	const fetch = globalThis.fetch;
	process.env.CURSOR_API_KEY = "fake-key";
	const agent = cursor.items[0]!;
	const run = { id: "run-123", agentId: agent.id };
	let rejectFollowUp = false;
	globalThis.fetch = (async (url, options) => {
		expect(options?.headers).toMatchObject({
			Authorization: "Bearer fake-key",
		});
		expect(options?.redirect).toBe("error");
		if (options?.method !== "POST") return Response.json(cursor);
		const body = JSON.parse(String(options.body));
		expect(body.prompt).toEqual({ text: create.prompt });
		if (url === "https://api.cursor.com/v1/agents") {
			expect(body.repos).toEqual([
				{ url: "https://github.com/example/repo", startingRef: "main" },
			]);
			expect(body.autoCreatePR).toBe(false);
			return Response.json({ agent, run });
		}
		expect(url).toBe(`https://api.cursor.com/v1/agents/${agent.id}/runs`);
		if (rejectFollowUp)
			return Response.json({ error: "agent_busy" }, { status: 409 });
		return Response.json({ run });
	}) as typeof globalThis.fetch;
	try {
		expect(await readHosted("cursor")).toMatchObject({
			state: "ready",
			tasks: [{ id: agent.id }],
		});
		const submit = (await hostedWriter("cursor"))!;
		expect(
			await submit({ ...create, provider: "cursor", ref: "main" }),
		).toMatchObject({ state: "accepted", id: agent.id, runId: run.id });
		expect(
			await submit({
				provider: "cursor",
				action: "follow-up",
				id: agent.id,
				prompt: create.prompt,
				nonce: crypto.randomUUID(),
			}),
		).toMatchObject({ state: "accepted", id: agent.id, runId: run.id });
		rejectFollowUp = true;
		const store = new Store(":memory:");
		try {
			const request = {
				provider: "cursor",
				action: "follow-up",
				id: agent.id,
				prompt: create.prompt,
				nonce: crypto.randomUUID(),
			} as const;
			const writes = new HostedWrites(store);
			expect(await writes.run("operator", request)).toEqual({
				state: "rejected",
				status: 409,
			});
			rejectFollowUp = false;
			expect(await writes.run("operator", request)).toEqual({
				state: "rejected",
				status: 409,
			});
			expect(
				await writes.run("operator", {
					...request,
					nonce: crypto.randomUUID(),
				}),
			).toMatchObject({ state: "accepted", id: agent.id });
		} finally {
			store.close();
		}
	} finally {
		globalThis.fetch = fetch;
		if (prior === undefined) delete process.env.CURSOR_API_KEY;
		else process.env.CURSOR_API_KEY = prior;
	}
});
