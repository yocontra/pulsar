/**
 * Code formatted for display (format.ts) and how a code block shows it:
 * formatted text, "Original" to see it as written, Copy copies it as written.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlock, TerminalBlock } from "../src/session/CodeBlock.tsx";
import {
	FORMAT_MAX,
	formatCode,
	formatJson,
	splitChain,
} from "../src/session/format.ts";

describe("formatCode", () => {
	test("one-line TypeScript becomes several lines", async () => {
		const src =
			'const repo = "/w/demo"; const r = await tools.exec_command({cmd: "bun test", workdir: repo}); text(JSON.stringify(r));';
		const out = await formatCode(src, "typescript");
		expect(out).not.toBeNull();
		expect(out!.split("\n").length).toBeGreaterThan(2);
		expect(out).toContain('const repo = "/w/demo";');
		expect(out).toContain("await tools.exec_command({");
	});

	test("JavaScript and JSON", async () => {
		expect(await formatCode("function f(a,b){return a+b}", "javascript")).toBe(
			"function f(a, b) {\n  return a + b;\n}",
		);
		expect(formatJson('{"a":1,"b":[1,2]}')).toBe(
			'{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
		);
		expect(await formatCode('{"a":1}', "json")).toBe('{\n  "a": 1\n}');
	});

	test("invalid, huge, unchanged or unknown: left as written", async () => {
		expect(await formatCode("const = = ;(", "typescript")).toBeNull();
		expect(await formatCode("{nope", "json")).toBeNull();
		expect(
			await formatCode(
				`const a = 1;\n${"x;\n".repeat(FORMAT_MAX)}`,
				"typescript",
			),
		).toBeNull();
		expect(await formatCode("const a = 1;", "typescript")).toBeNull();
		expect(await formatCode("print( 1 )", "python")).toBeNull();
	});
});

describe("splitChain (Bash, display only)", () => {
	test("top-level && and ; chains, one step per line", () => {
		expect(
			splitChain(
				"cd packages/net && bun install --frozen-lockfile && bun run build; bun test --coverage",
			),
		).toBe(
			"cd packages/net &&\n  bun install --frozen-lockfile &&\n  bun run build\n  bun test --coverage",
		);
	});

	test("anything unsure stays as written", () => {
		const long = (s: string) => `${s} ${"x".repeat(60)}`;
		const atWidth = "echo x && echo ".padEnd(80, "x");
		expect(splitChain(atWidth)).toBeNull();
		expect(splitChain(`${atWidth}x`)).toContain("&&\n");
		expect(splitChain(long("echo 'a && b; c'"))).toBeNull();
		expect(splitChain(long('echo "a && $(b; c)"'))).toBeNull();
		expect(splitChain(long("(cd a && make) | tee log"))).toBeNull();
		expect(splitChain(long("cat <<EOF && ls"))).toBeNull();
		expect(splitChain(long("case $x in a) ls;; esac"))).toBeNull();
		expect(splitChain(long("ls # a && b"))).toBeNull();
		expect(splitChain(long("echo 'unterminated && x"))).toBeNull();
		expect(splitChain("a &&\nb")).toBeNull();
	});
});

describe("a formatted block", () => {
	test("shows the formatted text; Copy and Original keep it as written", async () => {
		const src = "function f(a,b){return a+b}";
		await formatCode(src, "javascript");
		const h = renderToStaticMarkup(
			<CodeBlock code={src} lang="javascript" title="Script" format />,
		);
		expect(h).toContain("is-formatted");
		expect(h).toContain(">Original<");
		expect(h).toContain("return a + b;");
		expect(h).toContain(`aria-label="Copy Script"`);
		// Unformatted unless asked.
		const plain = renderToStaticMarkup(
			<CodeBlock code={src} lang="javascript" title="Script" />,
		);
		expect(plain).not.toContain("is-formatted");
	});

	test("a terminal splits a long chain only when asked", async () => {
		const cmd =
			"cd packages/net && bun install --frozen-lockfile && bun run build; bun test --coverage";
		await formatCode(cmd, "bash");
		const on = renderToStaticMarkup(
			<TerminalBlock command={cmd} formatCommand />,
		);
		expect(on).toContain(">Original<");
		expect(on.match(/ds-term-cmd/g)?.length).toBe(4);
		const off = renderToStaticMarkup(<TerminalBlock command={cmd} />);
		expect(off.match(/ds-term-cmd/g)?.length).toBe(1);
	});
});
