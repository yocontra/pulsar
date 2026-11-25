import { expect, test } from "bun:test";
import { readHosted, viewHosted } from "../src/hosted/providers.ts";

const base = "https://api.cursor.com/v1/agents";
const active = {
	id: "bc-active",
	name: "Update readme",
	status: "ACTIVE",
	latestRunId: "run-latest",
	url: "https://cursor.com/agents/bc-active?token=secret",
	updatedAt: "2026-04-13T18:30:00.000Z",
};
const archived = { ...active, id: "bc-archived", status: "ARCHIVED" };
const fresh = { ...active, id: "bc-fresh", latestRunId: null };

async function withCursor(
	handle: (url: string, options?: RequestInit) => Response,
	check: () => Promise<void>,
) {
	const key = process.env.CURSOR_API_KEY;
	const originalFetch = globalThis.fetch;
	process.env.CURSOR_API_KEY = "fake-key";
	globalThis.fetch = (async (url, options) => {
		expect(options?.method ?? "GET").toBe("GET");
		return handle(String(url), options);
	}) as typeof globalThis.fetch;
	try {
		await check();
	} finally {
		globalThis.fetch = originalFetch;
		if (key === undefined) delete process.env.CURSOR_API_KEY;
		else process.env.CURSOR_API_KEY = key;
	}
}

test("Cursor list uses one read and distinguishes durable agent state from run state", async () => {
	let reads = 0;
	await withCursor(
		(url) => {
			reads++;
			expect(url).toBe(`${base}?limit=20`);
			return Response.json({ items: [active, archived, fresh] });
		},
		async () => {
			expect(await readHosted("cursor")).toMatchObject({
				state: "ready",
				tasks: [
					{
						id: active.id,
						status: "Run status unavailable",
						url: "https://cursor.com/agents/bc-active",
					},
					{ id: archived.id, status: "ARCHIVED", url: null },
					{ id: fresh.id, status: "No run yet" },
				],
			});
			expect(reads).toBe(1);
		},
	);
});

test("Cursor detail reads the latest run and returns only safe metadata", async () => {
	const signals: (AbortSignal | null | undefined)[] = [];
	const updatedAt = "2026-04-13T18:45:00.000Z";
	await withCursor(
		(url, options) => {
			signals.push(options?.signal);
			if (url === `${base}/${active.id}`) return Response.json(active);
			expect(url).toBe(`${base}/${active.id}/runs/${active.latestRunId}`);
			return Response.json({
				id: active.latestRunId,
				agentId: active.id,
				status: "FINISHED",
				updatedAt,
				result: "private reply",
				git: {
					branches: [
						{ repoUrl: "github.com/example/repo" },
						{ repoUrl: "github.com/example/repo" },
						{ repoUrl: "https://user:private@github.com/example/private" },
					],
				},
			});
		},
		async () => {
			const task = await viewHosted("cursor", active.id);
			expect(task).toMatchObject({
				id: active.id,
				status: "FINISHED",
				updatedAt: Date.parse(updatedAt),
				context: "example/repo",
			});
			expect(JSON.stringify(task)).not.toContain("private");
			expect(signals).toHaveLength(2);
			expect(signals[0]).toBe(signals[1]);
		},
	);
});

test("Cursor detail keeps agent context when the run belongs to another agent", async () => {
	await withCursor(
		(url) =>
			url === `${base}/${active.id}`
				? Response.json({
						...active,
						repos: [{ url: "https://github.com/example/configured" }],
					})
				: Response.json({
						id: active.latestRunId,
						agentId: archived.id,
						status: "RUNNING",
					}),
		async () => {
			expect(await viewHosted("cursor", active.id)).toMatchObject({
				id: active.id,
				status: "Run status unavailable",
				context: "example/configured",
				updatedAt: Date.parse(active.updatedAt),
			});
		},
	);
});
