import { composerSuite, openAgent, PNG } from "./composer.shared.ts";
import { expect, test } from "./fixtures.ts";

composerSuite("desktop");

/** In the page: a paste or a drop carrying files (DataTransfer). */
function dispatch({
	kind,
	files,
	text,
}: {
	kind: string;
	files: { name: string; type: string; b64?: string; text?: string }[];
	text?: string;
}) {
	const dt = new DataTransfer();
	for (const f of files)
		dt.items.add(
			new File(
				[
					f.b64
						? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
						: (f.text ?? ""),
				],
				f.name,
				{ type: f.type },
			),
		);
	if (text) dt.setData("text/plain", text);
	const ta = document.querySelector<HTMLTextAreaElement>(
		".composer .composer-input",
	)!;
	const target = kind === "paste" ? ta : ta.closest(".composer")!;
	const init = { bubbles: true, cancelable: true };
	target.dispatchEvent(
		kind === "paste"
			? new ClipboardEvent("paste", { ...init, clipboardData: dt })
			: new DragEvent(kind, { ...init, dataTransfer: dt }),
	);
}

test("paste an image or long text; drop files on the composer", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const tiles = composer.getByTestId("attachment");
	const png = {
		name: "image.png",
		type: "image/png",
		b64: PNG.toString("base64"),
	};
	await page.evaluate(dispatch, { kind: "paste", files: [png] });
	await expect(tiles).toHaveCount(1);
	await expect(tiles.first()).toHaveAttribute("data-state", "done");
	// Long text becomes a .txt file; short text stays text.
	await page.evaluate(dispatch, {
		kind: "paste",
		files: [],
		text: "x".repeat(40 * 1024),
	});
	await expect(
		page.getByText(/^Large paste attached as Pasted text/),
	).toBeVisible();
	await expect(tiles).toHaveCount(2);
	await expect(tiles.nth(1)).toContainText(".txt");
	// Dragging shows the drop target; dropping attaches.
	await page.evaluate(dispatch, { kind: "dragenter", files: [png] });
	await expect(composer.getByText("Drop files to attach")).toBeVisible();
	await page.evaluate(dispatch, {
		kind: "drop",
		files: [{ name: "dropped.md", type: "text/markdown", text: "# hi" }],
	});
	await expect(composer.getByText("Drop files to attach")).toHaveCount(0);
	await expect(tiles).toHaveCount(3);
	await expect(tiles.nth(2)).toContainText("dropped.md");
	// A tile zooms; the preview closes.
	await composer.getByRole("button", { name: "Preview image.png" }).click();
	const zoom = page.getByRole("dialog", { name: "image.png" });
	await expect(zoom).toBeVisible();
	await zoom.getByRole("button", { name: "Close preview" }).click();
	await expect(zoom).toHaveCount(0);
});

test("without a passkey session, Prove Human comes first; closing it drops the files", async ({
	page,
	request,
}) => {
	await page.addInitScript(() => {
		(window as { __pulsarE2E?: object }).__pulsarE2E = {};
	});
	await page.goto("/");
	const res = await request.get(
		"/api/v1/agents?selector=name%3Dapparish-auth&limit=1",
		{ headers: { "X-Pulsar": "1" } },
	);
	const id = ((await res.json()) as { items: { id: string }[] }).items[0]!.id;
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	const composer = page.locator(".composer").last();
	await composer
		.getByTestId("attach-files")
		.setInputFiles([
			{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") },
		]);
	const sheet = page.getByRole("dialog", { name: "Prove Human" });
	await expect(sheet).toBeVisible();
	await expect(composer.getByTestId("attachment")).toHaveAttribute(
		"data-state",
		"preparing",
	);
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(composer.getByTestId("attachment")).toHaveCount(0);
});

test("removing a file while it uploads cancels its upload", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	// The mock holds every PUT for 4 s before handling it.
	const set = await request.post("/api/v1/__mock/faults", {
		headers: { "X-Pulsar": "1" },
		data: { rules: [{ method: "PUT", path: "/agents/", beforeMs: 4000 }] },
	});
	expect(set.ok()).toBe(true);
	const aborted = page.waitForEvent(
		"requestfailed",
		(r) => r.method() === "PUT" && r.url().includes("/attachments/"),
	);
	let finished = false;
	page.on("requestfinished", (r) => {
		if (r.method() === "PUT" && r.url().includes("/attachments/"))
			finished = true;
	});
	await composer
		.getByTestId("attach-files")
		.setInputFiles([
			{ name: "slow.txt", mimeType: "text/plain", buffer: Buffer.from("slow") },
		]);
	const tile = composer.getByTestId("attachment");
	await expect(tile).toHaveAttribute("data-state", "uploading");
	await composer.getByRole("button", { name: "Remove slow.txt" }).click();
	await aborted;
	await expect(tile).toHaveCount(0);
	expect(finished).toBe(false);
	await request.post("/api/v1/__mock/faults", {
		headers: { "X-Pulsar": "1" },
		data: {},
	});
});
