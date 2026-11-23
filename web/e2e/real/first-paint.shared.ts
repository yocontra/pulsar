import type { APIRequestContext, Page, Route } from "@playwright/test";
import type { Hello } from "../../src/api/types.ts";
import { expect } from "../fixtures.ts";

const H = { "X-Pulsar": "1" };

/** Holds every API request until `release()`. */
async function holdApi(page: Page) {
	const held: Route[] = [];
	let open = false;
	await page.route("**/api/v1/**", (route) => {
		if (open) return route.continue();
		held.push(route);
	});
	return {
		count: () => held.length,
		release: async () => {
			open = true;
			for (const r of held.splice(0)) await r.continue().catch(() => {});
		},
	};
}

/**
 * Visit, then revisit with every API request held: the last screen
 * (src/lib/snapshot.ts) paints at once, and the live answers replace it,
 * dropping a row that is no longer there. Needs-you paints from the
 * snapshot too: the desktop's card row for the agent that asked
 * (docs-writer), the phone's one-line summary ("N need you") with the
 * snapshot's count.
 */
export async function revisitPaintsFromSnapshot(
	page: Page,
	request: APIRequestContext,
	{ phone = false }: { phone?: boolean } = {},
) {
	const h = (await (
		await request.get("/api/v1/hello", { headers: H })
	).json()) as Hello;
	const machine = page.locator(`[data-node="m:${h.machineId}"]`);
	await page.goto("/");
	await expect(machine).toBeVisible();
	// The snapshot is written a second after the screen settles.
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("pulsar.snapshot")))
		.not.toBeNull();
	// A machine that has since left the pool, only in the snapshot.
	await page.evaluate(() => {
		const s = JSON.parse(localStorage.getItem("pulsar.snapshot")!);
		const top = s.nodes.find(
			(n: { id: string }) => n.id === s.branches[""].ids[0],
		);
		s.nodes.push({
			...top,
			id: "m:gone",
			label: "gone-machine",
			machineId: "gone",
		});
		s.branches[""].ids.push("m:gone");
		localStorage.setItem("pulsar.snapshot", JSON.stringify(s));
	});
	const asked = await page.evaluate(
		() =>
			(
				JSON.parse(localStorage.getItem("pulsar.snapshot")!) as {
					attention: { agent: { name: string } }[];
				}
			).attention,
	);
	expect(asked.map((a) => a.agent.name)).toContain("docs-writer");
	const api = await holdApi(page);
	await page.reload();
	// Rows paint from the snapshot while every API request is held.
	await expect(machine).toBeVisible();
	await expect(page.locator('[data-node="m:gone"]')).toBeVisible();
	if (phone) {
		const n = asked.length;
		// Ionic moves the row's aria-label onto its native button (in the
		// shadow root): that button is what a screen reader names.
		await expect(
			page.getByTestId("needs-summary").getByRole("button", {
				name: `${n} ${n === 1 ? "needs" : "need"} you`,
				exact: true,
			}),
		).toBeVisible();
	} else
		await expect(
			page
				.locator("[data-agent], .d-card-row")
				.filter({ hasText: "docs-writer" })
				.first(),
		).toBeVisible();
	expect(api.count()).toBeGreaterThan(0);
	// The network answers: live rows replace the snapshot's.
	await api.release();
	await expect(page.locator('[data-node="m:gone"]')).toHaveCount(0);
	await expect(machine).toBeVisible();
}
