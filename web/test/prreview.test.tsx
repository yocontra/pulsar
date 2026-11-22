import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitReviewThread } from "../src/api/types.ts";
import { parsePatch } from "../src/changes/patch.ts";
import {
	asChanged,
	openThreads,
	threadIndex,
} from "../src/features/prreview/data.ts";
import { DiffBody } from "../src/session/Diff.tsx";

const PATCH = "@@ -10,3 +10,4 @@ fn\n a\n-b\n+B\n+C\n c\n@@ -40 +41 @@\n-x\n+y";

describe("line numbers", () => {
	test("parsePatch numbers each row from its hunk header", () => {
		const rows = parsePatch(PATCH).items.filter((r) => "sign" in r);
		expect(
			rows.map((r) =>
				"sign" in r ? [r.sign, r.oldLine ?? null, r.newLine ?? null] : null,
			),
		).toEqual([
			[" ", 10, 10],
			["-", 11, null],
			["+", null, 11],
			["+", null, 12],
			[" ", 12, 13],
			["-", 40, null],
			["+", null, 41],
		]);
	});

	test("DiffBody: numbers and per-line extras in both layouts; none by default", () => {
		const p = parsePatch(PATCH);
		const extras = {
			gutter: (r: { oldLine?: number; newLine?: number }, side: string) => (
				<button
					type="button"
					data-g={`${side}:${side === "LEFT" ? r.oldLine : r.newLine}`}
				/>
			),
			after: (r: { oldLine?: number; newLine?: number }, side: string) =>
				side === "RIGHT" && r.newLine === 12 ? (
					<p className="t">thread</p>
				) : null,
		};
		for (const layout of ["unified", "split"] as const) {
			const html = renderToStaticMarkup(
				<DiffBody
					items={p.items}
					A={null}
					B={null}
					layout={layout}
					numbers
					extras={extras}
				/>,
			);
			expect(html).toContain('class="ds-diff-ln"');
			expect(html.match(/class="ds-diff-after"/g)?.length).toBe(1);
			expect(html).toContain('data-g="RIGHT:11"');
			expect(html).toContain('data-g="LEFT:11"');
		}
		const plain = renderToStaticMarkup(
			<DiffBody items={p.items} A={null} B={null} layout="unified" />,
		);
		expect(plain).not.toContain("ds-diff-ln");
		expect(plain).not.toContain("ds-diff-after");
	});
});

describe("threads", () => {
	const t = (
		id: string,
		path: string,
		line: number | null,
		side: "LEFT" | "RIGHT",
		resolved = false,
	): GitReviewThread => ({
		id,
		path,
		line,
		startLine: null,
		originalLine: line,
		side,
		outdated: line === null,
		resolved,
		canResolve: true,
		canReply: true,
		comments: [],
	});
	test("indexed by file and side:line; outdated apart; open counts", () => {
		const list = [
			t("1", "a", 4, "RIGHT"),
			t("2", "a", 4, "LEFT", true),
			t("3", "a", null, "RIGHT"),
			t("4", "b", 1, "RIGHT"),
		];
		const ix = threadIndex(list);
		expect(
			ix
				.get("a")
				?.at.get("RIGHT:4")
				?.map((x) => x.id),
		).toEqual(["1"]);
		expect(
			ix
				.get("a")
				?.at.get("LEFT:4")
				?.map((x) => x.id),
		).toEqual(["2"]);
		expect(ix.get("a")?.loose.map((x) => x.id)).toEqual(["3"]);
		expect(openThreads(list)).toBe(3);
		expect(openThreads(list, "a")).toBe(2);
	});
	test("files map to the changes list's rows", () => {
		expect(
			asChanged({
				path: "x",
				oldPath: null,
				status: "removed",
				added: 0,
				removed: 3,
				binary: false,
				tooLarge: false,
			}),
		).toMatchObject({ status: "deleted", removed: 3 });
		expect(
			asChanged({
				path: "y",
				oldPath: null,
				status: "modified",
				added: 1,
				removed: 1,
				binary: false,
				tooLarge: true,
			}),
		).toMatchObject({ added: null, removed: null });
	});
});
