/**
 * The approval card's safety view and layout, rendered to static HTML:
 * hidden characters stay visible as markers inside highlighted code, every
 * input key is shown, the project name replaces the full path, and a
 * question shows its header and each option's description.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval } from "../src/api/types.ts";
import {
	ApprovalDetails,
	projectName,
	WhereLine,
} from "../src/approval/ApprovalDetails.tsx";
import { QuestionForm } from "../src/interactions/QuestionForm.tsx";
import { MarkHidden, Tok } from "../src/session/highlight.tsx";

const base: Approval = {
	requestId: "apr_1",
	kind: "permission",
	agentId: "a1",
	machine: "studio",
	tool: "Bash",
	input: {
		command: "rm -rf dist && bun build\necho ‮txt.exe​",
		description: "Clean and rebuild",
		timeout: 120000,
	},
	inputHash: "sha256:abc",
	cwd: "/Users/me/Projects/apparish",
	branch: "fix-1378",
	createdAt: 0,
	expiresAt: 0,
	state: "pending",
	sessionRules: ["Bash(bun build *)"],
};
const agent = {
	name: "apparish-auth",
	machine: "studio",
	harness: "claude",
	project: "apparish",
};

const html = (ap: Approval) =>
	renderToStaticMarkup(
		<ApprovalDetails approval={ap} agent={agent} variant="desktop" />,
	);

describe("approval card", () => {
	test("Bash: the description leads, the command shows bidi and zero-width characters as markers", () => {
		const h = html(base);
		expect(h.indexOf("Clean and rebuild")).toBeLessThan(h.indexOf("rm -rf"));
		expect(h).toContain('class="mk mk-ctl">&lt;U+202E&gt;');
		expect(h).toContain('class="mk mk-ctl">&lt;U+200B&gt;');
		// The raw characters never reach the page.
		expect(h).not.toContain("‮");
		expect(h).not.toContain("​");
		// A key the Bash view doesn't render is still listed exactly.
		expect(h).toContain("timeout");
		expect(h).toContain("120000");
	});

	test("a hidden character in a highlighted token is still a marker", () => {
		const h = renderToStaticMarkup(
			<MarkHidden.Provider value>
				<Tok t={{ content: "echo ⁦x⁩", offset: 0, color: "red" }} />
			</MarkHidden.Provider>,
		);
		expect(h).toContain("&lt;U+2066&gt;");
		expect(h).toContain("&lt;U+2069&gt;");
		expect(h).not.toContain("⁦");
	});

	test("where: the project name, the full path only on hover", () => {
		const h = html(base);
		expect(h).toContain(">apparish<");
		expect(h).toContain('title="/Users/me/Projects/apparish"');
		expect(h).not.toContain(">/Users/me/Projects/apparish<");
		expect(projectName(null, "/a/b/widgets/")).toBe("widgets");
		expect(
			renderToStaticMarkup(
				<WhereLine project={null} cwd={null} branch={null} />,
			),
		).toBe("");
	});

	test("Edit shows the file and every edit argument", () => {
		const h = html({
			...base,
			tool: "Edit",
			input: {
				file_path: "src/a.ts",
				old_string: "a",
				new_string: "b‮",
				replace_all: true,
			},
		});
		expect(h).toContain("src/a.ts");
		expect(h).toContain("replace_all");
	});

	test("an unknown tool lists every argument exactly", () => {
		const h = html({ ...base, tool: "Frobnicate", input: { x: "a b" } });
		expect(h).toContain(">x<");
		expect(h).toContain("mk-space");
	});
});

describe("question card", () => {
	test("shows the header chip and each option's description", () => {
		const h = renderToStaticMarkup(
			<QuestionForm
				approval={{ ...base, kind: "question" }}
				agent={agent as never}
				mobile={false}
				disabled={false}
				submit={() => {}}
				prompt={{
					kind: "question",
					questions: [
						{
							id: "Color?",
							question: "Color?",
							header: "Color",
							multiSelect: false,
							allowOther: true,
							options: [
								{ label: "Red", description: "Use red for the test." },
								{ label: "Green" },
							],
						},
					],
				}}
			/>,
		);
		expect(h).toContain(">Color<");
		expect(h).toContain("Use red for the test.");
		expect(h).toContain(">Green<");
	});
});
