/** Transcript links render only for http(s) and mailto (session/streamdown.tsx). */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import {
	changedFile,
	filePath,
	isFileHref,
	resolvePath,
} from "../src/session/file-ref.tsx";
import { components, rehypePlugins } from "../src/session/streamdown.tsx";

const hrefs = (md: string) =>
	renderToStaticMarkup(
		<Streamdown
			mode="static"
			rehypePlugins={rehypePlugins}
			components={components}
			linkSafety={{ enabled: false }}
		>
			{md}
		</Streamdown>,
	).match(/href="[^"]*"/g) ?? [];

describe("transcript links", () => {
	test("http(s) and mailto stay links, in a new tab", () => {
		for (const u of [
			"https://ok.example/",
			"http://ok.example/",
			"mailto:a@b.c",
		])
			expect(hrefs(`[l](${u}) <a href="${u}">r</a>`)).toEqual([
				`href="${u}"`,
				`href="${u}"`,
			]);
	});
	test("every other scheme is text", () => {
		for (const u of [
			"irc://x/y",
			"ircs://x",
			"xmpp:a@b",
			"javascript:alert(1)",
			"blob:http://localhost/abc",
			"tel:1",
		])
			expect(hrefs(`[l](${u}) <a href="${u}">r</a>`)).toEqual([]);
	});
});

describe("file links", () => {
	const html = (md: string) =>
		renderToStaticMarkup(
			<Streamdown
				mode="static"
				rehypePlugins={rehypePlugins}
				components={components}
				linkSafety={{ enabled: false }}
			>
				{md}
			</Streamdown>,
		);
	test("paths and file: URLs render as buttons, never as links", () => {
		for (const u of [
			"/Users/me/x/compare.html",
			"./docs/a.md",
			"../b.ts",
			"src/c.ts",
			"file:///tmp/a%20b.txt",
		]) {
			const out = html(`[f](${u})`);
			expect(out).not.toContain("<a");
			expect(out).toContain('class="file-ref"');
		}
	});
	test("an in-page anchor is text", () => {
		const out = html("[s](#usage)");
		expect(out).not.toContain("<a");
		expect(out).not.toContain("file-ref");
	});
});

describe("file reference helpers", () => {
	test("isFileHref and filePath", () => {
		expect(isFileHref("/a/b")).toBe(true);
		expect(isFileHref("./a")).toBe(true);
		expect(isFileHref("file:///a")).toBe(true);
		expect(isFileHref("https://x.dev/a")).toBe(false);
		expect(isFileHref("mailto:a@b.c")).toBe(false);
		expect(isFileHref("//cdn.example/x")).toBe(false);
		expect(isFileHref("#top")).toBe(false);
		expect(filePath("file:///tmp/a%20b.txt")).toBe("/tmp/a b.txt");
		expect(filePath("/a/b.ts#L10")).toBe("/a/b.ts");
		expect(filePath("./x%20y.md?raw")).toBe("./x y.md");
	});
	test("resolvePath against the agent's folder", () => {
		expect(resolvePath("./a.ts", "/w/repo")).toBe("/w/repo/a.ts");
		expect(resolvePath("../b.ts", "/w/repo/sub")).toBe("/w/repo/b.ts");
		expect(resolvePath("/abs", "/w")).toBe("/abs");
		expect(resolvePath("rel", null)).toBe("rel");
	});
	test("changedFile: only a file the Changes view lists", () => {
		const summary = {
			root: "/w/repo",
			files: [{ path: "src/a.ts" }],
		} as Parameters<typeof changedFile>[1];
		expect(changedFile("/w/repo/src/a.ts", summary)).toBe("src/a.ts");
		expect(changedFile("/w/repo/src/b.ts", summary)).toBeNull();
		expect(changedFile("/w/repo-other/src/a.ts", summary)).toBeNull();
		expect(changedFile("/w/repo/src/a.ts", undefined)).toBeNull();
	});
});
