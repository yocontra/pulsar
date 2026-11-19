import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { dedupe, TranscriptTailer } from "../src/transcripts/tailer.ts";
import {
	newParseState,
	type TranscriptEvent,
} from "../src/transcripts/types.ts";

/** A 1×1 PNG. */
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG, "base64");
/** Enough of a JPEG for type sniffing. */
const JPEG = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1,
]).toString("base64");
const WEBP_BYTES = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.from([4, 0, 0, 0]),
	Buffer.from("WEBPVP8 "),
]);
const SVG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
).toString("base64");

const parse = (harness: string) =>
	(driverFor(harness) as HarnessDriver).transcript!.parse;

function parseLines(harness: string, records: object[]) {
	const state = newParseState({ atStart: false, cwd: "/work/demo" });
	const text = records.map((r) => `${JSON.stringify(r)}\n`).join("");
	return { events: dedupe(parse(harness)(text, state)), state };
}

const withImages = (events: TranscriptEvent[]) =>
	events.filter((e) => e.images?.length);

const TS = "2026-11-10T12:00:00.000Z";

// Claude records.
const claudeImage = (data: string, mediaType = "image/png") => ({
	type: "image",
	source: { type: "base64", media_type: mediaType, data },
});
const claudeUser = (uuid: string, content: unknown[]) => ({
	type: "user",
	uuid,
	timestamp: TS,
	message: { role: "user", content },
});
const claudeCall = (uuid: string, callId: string) => ({
	type: "assistant",
	uuid,
	timestamp: TS,
	message: {
		id: `msg-${uuid}`,
		model: "claude-test",
		content: [{ type: "tool_use", id: callId, name: "Screenshot", input: {} }],
	},
});

// Codex records.
const codexItem = (payload: object) => ({
	timestamp: TS,
	type: "response_item",
	payload,
});

// pi records.
const piResult = (id: string, callId: string, content: unknown[]) => ({
	type: "message",
	id,
	timestamp: TS,
	message: {
		role: "toolResult",
		toolCallId: callId,
		toolName: "shot",
		content,
	},
});

describe("parsers: images", () => {
	test("claude: pasted images, tool_result screenshots; no data in events", () => {
		const { events, state } = parseLines("claude", [
			claudeUser("u1", [
				claudeImage(PNG),
				{ type: "text", text: "[Image #1] what is this?" },
			]),
			claudeUser("u2", [claudeImage(JPEG, "image/jpeg")]),
			claudeCall("a1", "toolu_1"),
			claudeUser("u3", [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [{ type: "text", text: "shot" }, claudeImage(PNG)],
				},
			]),
		]);
		const prompt = events.find((e) => e.id === "u1#1")!;
		expect(prompt.text).toBe("[Image #1] what is this?");
		expect(prompt.images).toEqual([
			{
				id: "u1#1#img0",
				mediaType: "image/png",
				url: "",
				bytes: PNG_BYTES.length,
			},
		]);
		const only = events.find((e) => e.id === "u2#0")!;
		expect(only).toMatchObject({ role: "user", kind: "text", text: "[image]" });
		expect(only.images?.[0]?.mediaType).toBe("image/jpeg");
		const result = events.find((e) => e.kind === "tool_result")!;
		expect(result.images?.map((i) => i.id)).toEqual(["u3#0#img0"]);
		// The re-emitted call carries no images.
		expect(events.find((e) => e.kind === "tool_call")!.images).toBeUndefined();
		expect(state.images.get("u3#0#img0")).toEqual({
			mediaType: "image/png",
			at: ["message", "content", 0, "content", 1, "source", "data"],
			encoding: "base64",
		});
		expect(JSON.stringify(events)).not.toContain(PNG.slice(0, 20));
		expect(JSON.stringify(events)).not.toContain(JPEG.slice(0, 8));
	});

	test("claude: SVG and URL images are dropped", () => {
		const { events, state } = parseLines("claude", [
			claudeUser("u1", [
				claudeImage(SVG, "image/svg+xml"),
				{ type: "image", source: { type: "url", url: "https://x.test/a.png" } },
				{ type: "text", text: "look" },
			]),
		]);
		expect(withImages(events)).toEqual([]);
		expect(state.images.size).toBe(0);
	});

	test("codex: tool output images (array or JSON string), user images; URLs dropped", () => {
		const { events } = parseLines("codex", [
			codexItem({
				type: "custom_tool_call",
				id: "ctc_1",
				call_id: "call_1",
				name: "exec",
				input: "shot()",
			}),
			codexItem({
				type: "custom_tool_call_output",
				id: "ctco_1",
				call_id: "call_1",
				output: [
					{ type: "input_text", text: "Script completed" },
					{
						type: "input_image",
						image_url: `data:image/png;base64,${PNG}`,
						detail: "high",
					},
					{ type: "input_image", image_url: "https://x.test/remote.png" },
					{
						type: "input_image",
						image_url: `data:image/svg+xml;base64,${SVG}`,
					},
				],
			}),
			codexItem({
				type: "function_call_output",
				id: "fco_2",
				call_id: "call_2",
				output: JSON.stringify([
					{ type: "input_image", image_url: `data:image/jpeg;base64,${JPEG}` },
				]),
			}),
			codexItem({
				type: "message",
				id: "msg_u",
				role: "user",
				content: [
					{ type: "input_text", text: "see attached" },
					{ type: "input_image", image_url: `data:image/png;base64,${PNG}` },
				],
			}),
		]);
		const shot = events.find((e) => e.id === "ctco_1")!;
		expect(shot.images).toEqual([
			{
				id: "ctco_1#img0",
				mediaType: "image/png",
				url: "",
				bytes: PNG_BYTES.length,
			},
		]);
		expect(events.find((e) => e.id === "fco_2")!.images?.[0]?.mediaType).toBe(
			"image/jpeg",
		);
		expect(events.find((e) => e.id === "msg_u")!.images?.[0]?.id).toBe(
			"msg_u#img0",
		);
		expect(JSON.stringify(events)).not.toContain(PNG.slice(0, 20));
		expect(JSON.stringify(events)).not.toContain("remote.png");
	});

	test("pi / omp: tool result images, inline base64 or blob refs", () => {
		const hash = "a".repeat(64);
		const { events, state } = parseLines("pi", [
			piResult("r1", "c1", [
				{ type: "text", text: "done" },
				{ type: "image", data: PNG, mimeType: "image/png" },
				{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/webp" },
				{ type: "image", data: "blob:sha256:../../etc", mimeType: "image/png" },
				{ type: "image", data: SVG, mimeType: "image/svg+xml" },
			]),
			{
				type: "message",
				id: "u1",
				timestamp: TS,
				message: {
					role: "user",
					content: [{ type: "image", data: PNG, mimeType: "image/png" }],
				},
			},
		]);
		const result = events.find((e) => e.id === "r1")!;
		expect(result.images).toEqual([
			{
				id: "r1#img0",
				mediaType: "image/png",
				url: "",
				bytes: PNG_BYTES.length,
			},
			{ id: "r1#img1", mediaType: "image/webp", url: "" },
		]);
		expect(state.images.get("r1#img1")?.encoding).toBe("blob");
		expect(events.find((e) => e.id === "u1")!.images?.[0]?.id).toBe("u1#img0");
		expect(JSON.stringify(events)).not.toContain(PNG.slice(0, 20));
	});
});

describe("tailer: images", () => {
	let dir: string;
	let tailer: TranscriptTailer;
	const paths = new Map<string, { path: string; harness: string }>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-images-"));
		paths.clear();
		tailer = new TranscriptTailer({
			pollMs: 20,
			resolve: (id) => {
				const p = paths.get(id);
				return p
					? { source: { kind: "file", path: p.path }, parse: parse(p.harness) }
					: null;
			},
		});
	});
	afterEach(() => {
		tailer.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const write = (file: string, records: object[]) =>
		writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));

	test("a page gives URLs; the image reads back by id, only for its agent", async () => {
		const file = join(dir, "claude.jsonl");
		write(file, [
			claudeUser("u1", [claudeImage(PNG), { type: "text", text: "hi" }]),
		]);
		paths.set("claude:one", { path: file, harness: "claude" });
		paths.set("claude:two", { path: file, harness: "claude" });
		const page = (await tailer.read("claude:one"))!;
		const image = page.events[0]!.images![0]!;
		expect(image.url).toBe(
			"/api/v1/agents/claude%3Aone/transcript/images/u1%231%23img0",
		);
		const got = await tailer.image("claude:one", image.id);
		expect(got).toEqual({ ok: true, mediaType: "image/png", data: PNG_BYTES });
		// Another agent has not been shown this image.
		expect(await tailer.image("claude:two", image.id)).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await tailer.image("claude:one", "u1#1#img9")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	test("live lines are indexed; a replaced file no longer serves old ids", async () => {
		const file = join(dir, "pi.jsonl");
		write(file, [
			{
				type: "message",
				id: "u0",
				timestamp: TS,
				message: { role: "user", content: "start" },
			},
		]);
		paths.set("pi:live", { path: file, harness: "pi" });
		const got: TranscriptEvent[] = [];
		const off = tailer.subscribe("pi:live", (events) => {
			got.push(...events);
		});
		await tailer.ready("pi:live");
		appendFileSync(
			file,
			`${JSON.stringify(
				piResult("r1", "c1", [
					{ type: "image", data: PNG, mimeType: "image/png" },
				]),
			)}\n`,
		);
		await tailer.poke();
		const deadline = Date.now() + 2000;
		while (!got.some((e) => e.images) && Date.now() < deadline)
			await Bun.sleep(10);
		const image = got.find((e) => e.images)!.images![0]!;
		expect(image.url).toContain("/transcript/images/r1%23img0");
		expect((await tailer.image("pi:live", "r1#img0")).ok).toBe(true);
		off();
		// Replaced by another file: the remembered location is stale.
		rmSync(file);
		write(file, [
			{
				type: "message",
				id: "x",
				timestamp: TS,
				message: { role: "user", content: "new" },
			},
		]);
		expect((await tailer.image("pi:live", "r1#img0")).ok).toBe(false);
	});

	test("omp blob refs read from <agent dir>/blobs; bytes decide the type", async () => {
		const agentDir = join(dir, "agent");
		const sessions = join(agentDir, "sessions", "--work--", "parent");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(join(agentDir, "blobs"));
		const hash = "b".repeat(64);
		writeFileSync(join(agentDir, "blobs", hash), WEBP_BYTES);
		const file = join(sessions, "sub.jsonl");
		write(file, [
			piResult("r1", "c1", [
				{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/webp" },
				{
					type: "image",
					data: `blob:sha256:${"c".repeat(64)}`,
					mimeType: "image/png",
				},
				// Declared PNG, but the bytes are SVG.
				{ type: "image", data: SVG, mimeType: "image/png" },
			]),
		]);
		paths.set("omp:s", { path: file, harness: "pi" });
		await tailer.read("omp:s");
		expect(await tailer.image("omp:s", "r1#img0")).toEqual({
			ok: true,
			mediaType: "image/webp",
			data: WEBP_BYTES,
		});
		expect(await tailer.image("omp:s", "r1#img1")).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await tailer.image("omp:s", "r1#img2")).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	test("a PDF a Read returned is a document, served only when the bytes are a PDF", async () => {
		const pdf = Buffer.from(
			"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 2 >> endobj\n3 0 obj << /Type /Page >> endobj\n4 0 obj << /Type /Page >> endobj\n%%EOF\n",
		);
		const doc = (data: string) => ({
			type: "document",
			source: { type: "base64", media_type: "application/pdf", data },
		});
		const file = join(dir, "pdf.jsonl");
		write(file, [
			{
				type: "assistant",
				uuid: "a1",
				timestamp: TS,
				message: {
					id: "m1",
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Read",
							input: { file_path: "/w/docs/spec.pdf" },
						},
					],
				},
			},
			claudeUser("u1", [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: [
						{ type: "text", text: "PDF file read" },
						doc(pdf.toString("base64")),
						doc(Buffer.from("<html><script>x</script>").toString("base64")),
					],
				},
			]),
		]);
		paths.set("claude:pdf", { path: file, harness: "claude" });
		const page = (await tailer.read("claude:pdf"))!;
		const result = page.events.find((e) => e.kind === "tool_result")!;
		expect(result.documents?.[0]).toMatchObject({
			id: "u1#0#doc0",
			mediaType: "application/pdf",
			name: "spec.pdf",
			pages: 2,
			bytes: pdf.length,
		});
		expect(result.documents?.[0]?.url).toContain(
			"/transcript/images/u1%230%23doc0",
		);
		expect(await tailer.image("claude:pdf", "u1#0#doc0")).toEqual({
			ok: true,
			mediaType: "application/pdf",
			data: pdf,
		});
		// Declared a PDF, but not one: never served.
		expect(await tailer.image("claude:pdf", "u1#0#doc1")).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	test("images over 10 MB are refused before decoding", async () => {
		const file = join(dir, "big.jsonl");
		const big = "A".repeat(Math.ceil(((10 * 1024 * 1024 + 10) * 4) / 3));
		write(file, [
			piResult("r1", "c1", [
				{ type: "image", data: big, mimeType: "image/png" },
			]),
		]);
		paths.set("pi:big", { path: file, harness: "pi" });
		await tailer.read("pi:big");
		expect(await tailer.image("pi:big", "r1#img0")).toEqual({
			ok: false,
			reason: "too_large",
		});
	});
});
