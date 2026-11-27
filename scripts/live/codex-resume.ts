// Run the installed Codex CLI in a disposable workspace against a local model fixture.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { codex } from "../../src/harnesses/codex.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pulsar-codex-resume-"));
const cwd = join(root, "work");
const home = join(root, "home");
const codexHome = join(home, ".codex");
const env = {
	HOME: home,
	CODEX_HOME: codexHome,
	PATH: process.env.PATH,
	TERM: "xterm-256color",
	SHELL: "/bin/sh",
	TMUX_TMPDIR: root,
};
async function run(cmd: string, args: string[]) {
	const result = exec(cmd, args, {
		env,
		cwd,
		timeout: 45000,
		maxBuffer: 4 * 1024 * 1024,
	});
	result.child.stdin?.end();
	return (await result).stdout;
}
const first = "PULSAR_SELECTED_CONVERSATION";
const decoy = "PULSAR_OTHER_CONVERSATION";
const followup = "PULSAR_CONTINUATION";
const reply = "PULSAR_MODEL_ANSWER";
let continued = false;
let count = 0;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		if (
			req.method !== "POST" ||
			!new URL(req.url).pathname.endsWith("/responses")
		)
			return new Response(null, { status: 404 });
		const { input } = (await req.json()) as { input: unknown };
		const turns = JSON.stringify(input);
		if (turns.includes(followup))
			continued =
				turns.includes(first) &&
				turns.includes(reply) &&
				!turns.includes(decoy);
		const id = `resp_${++count}`;
		const item = {
			type: "message",
			id: `msg_${count}`,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: reply, annotations: [] }],
		};
		const events = [
			{ type: "response.created", response: { id } },
			{ type: "response.output_item.done", item },
			{
				type: "response.completed",
				response: {
					id,
					status: "completed",
					output: [item],
					usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
				},
			},
		];
		return new Response(
			events
				.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
				.join(""),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	},
});
try {
	await mkdir(codexHome, { recursive: true });
	await mkdir(cwd);
	await run("git", ["init", "-q"]);
	await writeFile(
		join(codexHome, "config.toml"),
		`model_provider = "fixture"
model = "gpt-5.5"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${server.port}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"
[analytics]
enabled = false
`,
	);
	async function start(prompt: string) {
		const output = await run("codex", [
			"exec",
			"--json",
			"--sandbox",
			"read-only",
			prompt,
		]);
		const lines = output
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		const id = lines.find((e) => e.type === "thread.started")?.thread_id;
		if (typeof id !== "string" || !output.includes(reply))
			throw new Error("Codex did not save the fixture turn");
		return id;
	}
	const selected = await start(first);
	if ((await start(decoy)) === selected)
		throw new Error("Codex reused a thread ID");
	process.env.CODEX_HOME = codexHome;
	const saved = await codex.readSession?.(selected);
	if (saved?.cwd !== cwd)
		throw new Error(
			"Pulsar did not find the selected session in its original workspace",
		);
	const argv = codex.nativeResume?.args(selected, saved);
	if (!argv) throw new Error("No native resume command");
	const tmux = (...args: string[]) =>
		run("tmux", ["-L", "qualification", ...args]);
	await tmux(
		"new-session",
		"-d",
		"-s",
		"resume",
		"-x",
		"150",
		"-y",
		"50",
		"--",
		...argv,
	);
	let screen = "";
	let choseModel = false;
	const deadline = Date.now() + 30000;
	do {
		screen = await tmux("capture-pane", "-pJ", "-S", "-1000", "-t", "resume:");
		if (screen.includes(first) && screen.includes(reply)) break;
		if (!choseModel && screen.includes("2. Use existing model")) {
			choseModel = true;
			await tmux("send-keys", "-t", "resume:", "Down", "Enter");
		}
		await delay(150);
	} while (Date.now() < deadline);
	if (
		!screen.includes(first) ||
		!screen.includes(reply) ||
		screen.includes(decoy)
	)
		throw new Error(
			`Resumed terminal did not show selected history: ${screen.slice(-2500)}`,
		);
	await tmux("send-keys", "-t", "resume:", "-l", followup);
	await tmux("send-keys", "-t", "resume:", "Enter");
	const until = Date.now() + 20000;
	while (!continued && Date.now() < until) await delay(150);
	if (!continued)
		throw new Error(
			"The model did not receive the selected history on the resumed turn",
		);
	console.log(
		"Codex reopened the selected thread and continued it with its own history.",
	);
} finally {
	await run("tmux", ["-L", "qualification", "kill-server"]).catch(() => {});
	server.stop(true);
	await rm(root, { recursive: true, force: true });
}
