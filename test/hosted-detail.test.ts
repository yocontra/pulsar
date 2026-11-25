import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { RemoteHosted } from "../src/federation/hosted.ts";
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import { cleanHostedDetail, viewHostedDetail } from "../src/hosted/details.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import { PulsarService } from "../src/service/index.ts";
import type { PoolMachine } from "../src/service/pool.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { restoreEnv, until } from "./helpers.ts";

const user = {
	kind: "human",
	login: "owner@example.net",
	node: "home",
} as const;
const cursor = {
	provider: "cursor",
	id: "bc-test",
	machineId: "remote",
} as const;
const task = {
	id: cursor.id,
	title: "Task name",
	status: "Running",
	context: null,
	url: null,
	updatedAt: null,
};
const detail = {
	...cursor,
	state: "ready",
	detail: { kind: "task", task },
} as const;

test("hosted details bound text and clean links without exposing other provider fields", async () => {
	const codex = { ...cursor, provider: "codex" as const };
	const result = await viewHostedDetail(
		codex,
		async () =>
			`\u001b[31mCloud status\u001b[0m\r\nOutput\0: ${"x".repeat(45_000)}`,
	);
	expect(result).toMatchObject({ ...codex, state: "ready" });
	if (result.state !== "ready" || result.detail.kind !== "text")
		throw new Error("Missing Codex text");
	expect(result.detail.text.length).toBe(32_000);
	expect(result.detail.text.slice(0, 23)).toContain("Cloud status\nOutput :");
	const raw = {
		...detail,
		secret: "unused",
		detail: {
			kind: "task",
			task: {
				...task,
				url: "https://cursor.com/agents/bc-test?token=secret#secret",
				secret: "unused",
			},
		},
	};
	expect(cleanHostedDetail(cursor, raw)).toEqual({
		...detail,
		detail: {
			kind: "task",
			task: { ...task, url: "https://cursor.com/agents/bc-test" },
		},
	});
	for (const url of [
		"https://cursor.com.evil.example/agents/bc-test",
		"https://token@cursor.com/agents/bc-test",
		"https://cursor.com/agents/another",
		"javascript:alert(1)",
	]) {
		expect(
			cleanHostedDetail(cursor, {
				...raw,
				detail: { kind: "task", task: { ...task, url } },
			}),
		).toEqual(detail);
	}
	expect(cleanHostedDetail(cursor, { ...raw, id: "bc-other" })).toMatchObject({
		state: "unavailable",
		reason: "read-failed",
	});
	expect(
		await viewHostedDetail(cursor, async () => {
			throw new Error("private provider output");
		}),
	).toMatchObject({ state: "unavailable", reason: "read-failed" });
});

test("remote hosted detail uses the requested machine and validates the response", async () => {
	let link: PoolMachine["link"] = "tailnet";
	let result: unknown = detail;
	let calls = 0;
	const remote = new RemoteHosted({
		machines: () => [{ machineId: "remote", name: "Remote", link, agents: 0 }],
		act: async (target, action, as) => {
			calls++;
			expect(target).toBe("remote/");
			expect(action).toEqual({
				op: "hosted.detail",
				id: cursor.id,
				provider: cursor.provider,
			});
			expect(as).toEqual(user);
			return { ok: true, detail: result };
		},
	});
	expect(
		await remote.detail(cursor.provider, cursor.id, cursor.machineId, user),
	).toEqual(detail);
	result = { ...detail, machineId: "other" };
	expect(
		await remote.detail(cursor.provider, cursor.id, cursor.machineId, user),
	).toMatchObject({ state: "unavailable", reason: "read-failed" });
	link = "asleep";
	expect(
		await remote.detail(cursor.provider, cursor.id, cursor.machineId, user),
	).toMatchObject({ state: "unavailable", reason: "source-unreachable" });
	expect(calls).toBe(2);
});

test("hosted task HTTP detail follows catalog authorization and never caches the response", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulsar-hosted-detail-"));
	const path = process.env.PATH;
	const store = new Store(join(dir, "db"));
	const service = new PulsarService({ store, machine: "home", scan: false });
	const http = new HttpTransport(service, {
		identity: new StaticIdentity(user.login, user.node),
		owner: user.login,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
	});
	try {
		await writeFile(
			join(dir, "codex"),
			'#!/bin/sh\n[ "$1 $2 $3" = "cloud status cloud-test" ] || exit 1\nprintf "Test status\\n"\n',
			{ mode: 0o700 },
		);
		process.env.PATH = [dir, path].filter(Boolean).join(delimiter);
		await http.listen();
		const get = (url: string) =>
			fetch(`http://127.0.0.1:${http.port}/api/v1/hosted${url}`, {
				headers: { "X-Pulsar": "1" },
			});
		const local = await get(
			`/codex/tasks/cloud-test?machine=${service.machineId}`,
		);
		expect(local.status).toBe(200);
		expect(local.headers.get("cache-control")).toBe("no-store");
		expect(await local.json()).toMatchObject({
			provider: "codex",
			state: "ready",
			detail: { kind: "text", text: "Test status" },
		});
		expect((await get("/codex/tasks/-invalid")).status).toBe(400);
		expect((await get("/junk/tasks/cloud-test")).status).toBe(400);
		expect(
			(await get("/codex/tasks/cloud-test?machine=invalid%2Fmachine")).status,
		).toBe(400);
		expect(
			await (await get("/codex/tasks/cloud-test?machine=other")).json(),
		).toMatchObject({ state: "unavailable", reason: "source-unreachable" });
		await expect(
			service.hostedTask({ kind: "terminal" }, "codex", "cloud-test"),
		).rejects.toMatchObject({ code: "forbidden" });
	} finally {
		restoreEnv("PATH", path);
		await http.close();
		service.stop();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("the federated hosted detail handler delegates only verified owner reads to the source", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulsar-fed-hosted-detail-"));
	const path = process.env.PATH;
	const tailnet = new FakeTailnet();
	const nodes: Array<Awaited<ReturnType<typeof startNode>>> = [];
	async function startNode(name: string) {
		tailnet.add(name, { login: user.login });
		const store = new Store(join(dir, name));
		const service = new PulsarService({ store, machine: name, scan: false });
		const http = new HttpTransport(service, {
			identity: tailnet.identity,
			owner: user.login,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
		});
		await http.listen();
		const fed = new Federation(service, {
			tailnet: tailnet.view(name),
			members: new PoolMembers(null),
			owner: user.login,
			intervals: { discoverMs: 50, heartbeatMs: 50, requestTimeoutMs: 2000 },
		});
		http.fed = fed;
		tailnet.serve(name, http.app, http.port);
		service.start();
		await fed.start();
		return { store, service, http, fed };
	}
	try {
		await writeFile(
			join(dir, "codex"),
			'#!/bin/sh\n[ "$1 $2 $3" = "cloud status cloud-test" ] || exit 1\nprintf "Remote status\\n"\n',
			{ mode: 0o700 },
		);
		process.env.PATH = [dir, path].filter(Boolean).join(delimiter);
		const local = await startNode("home");
		nodes.push(local);
		const source = await startNode("source");
		nodes.push(source);
		const target = source.service.machineId;
		await until(
			() =>
				local.fed
					.machines()
					.some(
						(machine) =>
							machine.machineId === target && machine.link === "tailnet",
					),
			5000,
		);
		expect(
			await local.service.hostedTask(user, "codex", "cloud-test", target),
		).toEqual({
			state: "ready",
			provider: "codex",
			id: "cloud-test",
			machineId: target,
			detail: { kind: "text", text: "Remote status" },
		});
		await expect(
			local.fed.act(
				`${target}/`,
				{ op: "hosted.detail", provider: "codex", id: "-invalid" },
				user,
			),
		).rejects.toMatchObject({ code: "bad_request" });
		await expect(
			local.fed.act(
				`${target}/`,
				{ op: "hosted.detail", provider: "codex", id: "cloud-test" },
				{ kind: "terminal" },
			),
		).rejects.toMatchObject({ code: "forbidden" });
	} finally {
		restoreEnv("PATH", path);
		for (const node of nodes.reverse()) {
			node.fed.stop();
			node.service.stop();
			await node.http.close();
			node.store.close();
		}
		await rm(dir, { recursive: true, force: true });
	}
}, 15_000);
