/**
 * The shared command card (tools/CommandBody.tsx, tools/CommandBlock.tsx)
 * for each harness's shell tools, from the chat-blocks gallery's synthetic
 * logs and hand-built calls.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { galleryEvents } from "../mock/blocks.ts";
import { buildItems, type Item } from "../src/session/items.ts";

mock.module("../src/components/ai-elements/message.tsx", () => ({
	MessageResponse: ({ children }: { children?: ReactNode }) => (
		<div className="md">{children}</div>
	),
}));
const { CommandBody } = await import("../src/session/tools/CommandBody.tsx");
const { CommandBlock } = await import("../src/session/tools/CommandBlock.tsx");
type Props = Parameters<typeof CommandBody>[0];

const text = (h: string) =>
	h
		.replace(/<[^>]+>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ");
const body = (p: Partial<Props> & { name: string; input: unknown }) =>
	renderToStaticMarkup(
		<CommandBody
			output=""
			isError={false}
			layout="unified"
			done
			agentCwd="/work/demo"
			{...p}
		/>,
	);

type ToolItem = Extract<Item, { t: "tool" }>;
const tools = buildItems(galleryEvents((id) => `/img/${id}`)).filter(
	(i): i is ToolItem => i.t === "tool",
);
const gallery = (name: string, re: RegExp) => {
	const it = tools.find(
		(t) =>
			t.call?.tool?.name === name &&
			re.test(JSON.stringify(t.call?.tool?.input)),
	)!;
	return body({
		name,
		input: it.call!.tool!.input,
		output: it.result?.text ?? "",
		...(it.call?.tool?.cwd ? { callCwd: it.call.tool.cwd } : {}),
	});
};

describe("command card", () => {
	test("Claude Bash: description as header, the recorded folder", () => {
		const h = gallery("Bash", /Build the web app/);
		expect(h).toContain("ds-term ds-cmd");
		expect(h).toContain('title="/work/demo/web"');
		expect(text(h)).toContain("in web/");
		expect(text(h)).toContain("Build the web app");
		expect(text(h)).toContain("bun run build");
		expect(text(h)).toContain("index.html");
	});

	test("a command at the project root shows the project's name", () => {
		const h = body({
			name: "exec_command",
			input: { cmd: "rg -n retry src", workdir: "/work/demo" },
		});
		expect(h).toContain('title="/work/demo"');
		expect(text(h)).toContain("in demo");
	});

	test("unknown folder: no label invented", () => {
		const h = body({
			name: "bash",
			input: { command: "ls", i: "List files" },
			agentCwd: null,
		});
		expect(h).not.toContain("ds-term-dir");
		expect(text(h)).toContain("List files");
	});

	test("Codex script: each command, its output, then the script folded", () => {
		const h = gallery("exec", /bun test net --reporter=dots/);
		const t = text(h);
		expect(t).toContain("bun test net --reporter=dots");
		expect(t).toContain("in packages/net/");
		expect(t).toContain("git -C /work/demo status --short");
		expect(t).toContain("4 pass");
		// The loop's command can't be read statically: shown as TypeScript.
		expect(h).toContain('data-lang="typescript"');
		expect(t).toContain("Script call");
		expect(t).toContain("Show script");
		expect(t).toContain("2.1 s");
		// The script itself stays folded until asked for.
		expect(t).not.toContain("text(JSON.stringify(a))");
	});

	test("a script with no commands keeps the plain code view", () => {
		const h = body({
			name: "exec",
			input: "text(String(1 + 1));",
			output: "2",
		});
		expect(h).not.toContain("ds-cmd");
		expect(text(h)).toContain("text(String(1 + 1));");
	});

	test("denied and failed states", () => {
		expect(
			text(
				body({
					name: "Bash",
					input: { command: "rm -rf build" },
					detail: { denied: true },
				}),
			),
		).toContain("permission was denied");
		const failed = body({
			name: "Bash",
			input: { command: "bun test" },
			output: "boom\nExit code 1",
			detail: { exitCode: 1 },
			isError: true,
		});
		expect(failed).toContain("is-failed");
		expect(text(failed)).toContain("Exit 1");
	});

	test("CommandBlock alone shows the command as given (for approvals)", () => {
		const h = renderToStaticMarkup(
			<CommandBlock command={"echo 'a' &&  ls"} cwd="/srv/x" />,
		);
		expect(text(h)).toContain("echo 'a' && ls");
		expect(h).toContain('title="/srv/x"');
	});
});
