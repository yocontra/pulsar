/**
 * The file viewer's route and the file references that open it
 * (lib/file-links.ts, session/file-ref.tsx): inside the agent's folder a
 * file reference opens the viewer; a changed file opens Changes first;
 * anything else copies the path.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fileRoute, insideFolder } from "../src/lib/file-links.ts";
import { hrefFor, parseHash, registerPageName } from "../src/lib/hash.ts";
import { FileRef, FileRefAgent } from "../src/session/file-ref.tsx";

describe("fileRoute", () => {
	test("#/file/<agent>?path=<rel>&line=<n>, round-tripping remote and subagent ids", () => {
		try {
			registerPageName("file");
		} catch {}
		expect(hrefFor(fileRoute("claude:x", "src/a.ts", 3))).toBe(
			"#/file/claude%3Ax?path=src%2Fa.ts&line=3",
		);
		for (const [id, path, line] of [
			["m1/claude:abc", "a/b c.ts", 3],
			["claude:x", "", undefined],
			["m1/claude:x/sub:y", "out/qa/report.html", undefined],
		] as const) {
			const r = fileRoute(id, path, line);
			expect(parseHash(hrefFor(r))).toEqual(r);
		}
	});
});

describe("insideFolder", () => {
	test("relative to the folder, '' for the folder itself", () => {
		expect(insideFolder("/w/repo/out/qa/x.html", "/w/repo")).toBe(
			"out/qa/x.html",
		);
		expect(insideFolder("/w/repo/./a/../b.ts", "/w/repo/")).toBe("b.ts");
		expect(insideFolder("/w/repo", "/w/repo")).toBe("");
		expect(insideFolder("~/p/app/a.ts", "~/p/app")).toBe("a.ts");
	});
	test("outside, relative, or no folder: null", () => {
		expect(insideFolder("/w/repo-old/a.ts", "/w/repo")).toBeNull();
		expect(insideFolder("/w/repo/../x", "/w/repo")).toBeNull();
		expect(insideFolder("/etc/hosts", "~/p/app")).toBeNull();
		expect(insideFolder("a.ts", "/w/repo")).toBeNull();
		expect(insideFolder("/w/repo/a.ts", null)).toBeNull();
	});
});

describe("FileRef", () => {
	const title = (path: string, agent = { id: "a1", cwd: "/w/repo" }) =>
		/title="([^"]*)"/.exec(
			renderToStaticMarkup(
				<FileRefAgent.Provider value={agent}>
					<FileRef path={path}>f</FileRef>
				</FileRefAgent.Provider>,
			),
		)?.[1];

	test("inside the agent's folder: opens the viewer", () => {
		expect(title("/w/repo/out/report.html")).toBe("Open out/report.html");
		expect(title("./src/a.ts")).toBe("Open src/a.ts");
	});
	test("outside it, or with no agent: copies", () => {
		expect(title("/tmp/run.log")).toBe("Copy /tmp/run.log");
		expect(title("../other/x")).toBe("Copy /w/other/x");
		expect(
			/title="([^"]*)"/.exec(
				renderToStaticMarkup(<FileRef path="src/a.ts" />),
			)?.[1],
		).toBe("Copy src/a.ts");
	});
});
