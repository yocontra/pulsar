import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../src/harnesses/claude.ts";
import type { Approval } from "../src/http/wire.ts";
import type { Principal } from "../src/service/caller.ts";
import type { PulsarService } from "../src/service/index.ts";
import { restoreEnv, startDaemon } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const ORIGIN = "http://localhost:4100";
const rp = { rpId: "localhost", origins: [ORIGIN] };
const user: Principal = {
	kind: "human",
	login: "me@example.com",
	node: "phone",
};

const input = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		session_id: "hook-sess",
		prompt_id: "turn-9",
		hook_event_name: "PermissionRequest",
		tool_name: "Bash",
		tool_input: { command: "git init -q", description: "init" },
		permission_suggestions: [
			{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "git init *" }],
				behavior: "allow",
				destination: "localSettings",
			},
		],
		permission_mode: "default",
		cwd: "/tmp/repo",
		transcript_path: "/nonexistent/t.jsonl",
		...over,
	});

/** Runs `pulsar hook claude-permission` from source, as Claude would. */
function runHook(home: string, stdin: string, args: string[] = []) {
	const child = spawn("node", [cli, "hook", "claude-permission", ...args], {
		env: { ...process.env, PULSAR_HOME: home },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	child.stdout.on("data", (c) => (out += c));
	child.stderr.on("data", (c) => (err += c));
	const started = Date.now();
	const done = new Promise<{
		code: number | null;
		out: string;
		err: string;
		ms: number;
	}>((resolve) =>
		child.on("close", (code) =>
			resolve({ code, out, err, ms: Date.now() - started }),
		),
	);
	child.stdin.end(stdin);
	return { child, done };
}

function nextPending(service: PulsarService): Promise<Approval> {
	return new Promise((resolve) => {
		const off = service.events.on("approval", ({ approval }) => {
			if (approval.state !== "pending") return;
			off();
			resolve(approval);
		});
	});
}

async function enroll(service: PulsarService) {
	const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: "localhost" });
	const options = await service.approvals.passkeys.registrationOptions(
		"me@example.com",
		rp,
		{ label: "iPhone" },
	);
	await service.approvals.passkeys.verifyRegistration(
		"me@example.com",
		rp,
		auth.register(options),
	);
	return auth;
}

async function decide(
	service: PulsarService,
	auth: SoftAuthenticator,
	id: string,
	decision: "allow-once" | "allow-session" | "deny",
	note?: string,
) {
	const options = await service.approvals.options(user, rp, id, decision, {
		note: note ?? null,
	});
	return service.approvals.decide(user, rp, id, {
		decision,
		...(note ? { note } : {}),
		assertion: auth.assert(
			(options as { options: { challenge: string } }).options,
		),
	});
}

describe("pulsar hook claude-permission (end to end)", () => {
	test("allow, allow for session, deny, terminal answer", async () => {
		const { daemon, home, cleanup } = await startDaemon({
			approvals: { probe: () => null, answerable: () => true },
		});
		try {
			const service = daemon.service;
			const auth = await enroll(service);

			// Allow once.
			let pending = nextPending(service);
			let run = runHook(home, input());
			let a = await pending;
			expect(a.tool).toBe("Bash");
			expect(a.agentId).toBe("claude:hook-sess");
			expect(service.registry.needsYou(a.agentId)?.reason).toBe("approval");
			await decide(service, auth, a.requestId, "allow-once");
			let r = await run.done;
			expect(r.code).toBe(0);
			expect(JSON.parse(r.out)).toEqual({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "allow" },
				},
			});

			// Allow for session: the rule comes back scoped to the session.
			pending = nextPending(service);
			run = runHook(home, input());
			a = await pending;
			await decide(service, auth, a.requestId, "allow-session");
			r = await run.done;
			expect(JSON.parse(r.out).hookSpecificOutput.decision).toEqual({
				behavior: "allow",
				updatedPermissions: [
					{
						type: "addRules",
						rules: [{ toolName: "Bash", ruleContent: "git init *" }],
						behavior: "allow",
						destination: "session",
					},
				],
			});

			// Deny with a note.
			pending = nextPending(service);
			run = runHook(home, input());
			a = await pending;
			await decide(service, auth, a.requestId, "deny", "not now");
			r = await run.done;
			expect(JSON.parse(r.out).hookSpecificOutput.decision).toEqual({
				behavior: "deny",
				message: "Denied from the Pulsar app: not now",
			});

			// Claude kills the hook when the terminal prompt is answered (Escape / No).
			pending = nextPending(service);
			run = runHook(home, input());
			a = await pending;
			const ended = new Promise<Approval>((resolve) => {
				const off = service.events.on("approval", ({ approval }) => {
					if (
						approval.requestId !== a.requestId ||
						approval.state === "pending"
					)
						return;
					off();
					resolve(approval);
				});
			});
			run.child.kill("SIGTERM");
			r = await run.done;
			expect(r.out).toBe("");
			const after = await ended;
			expect(after.state).toBe("answered-locally");
			expect(after.outcome).toMatch(/^Answered on /);
			expect(service.registry.needsYou(a.agentId)).toBeNull();
		} finally {
			await daemon.stop();
			cleanup();
		}
	}, 30_000);

	test("the daemon's timeout prints nothing, so Claude's own prompt decides", async () => {
		const { daemon, home, cleanup } = await startDaemon({
			approvals: { probe: () => null, timeoutMs: 300, answerable: () => true },
		});
		try {
			const r = await runHook(home, input()).done;
			expect(r).toMatchObject({ code: 0, out: "" });
		} finally {
			await daemon.stop();
			cleanup();
		}
	}, 20_000);

	test("--timeout from the hook command sets how long the app may answer", async () => {
		const { daemon, home, cleanup } = await startDaemon({
			approvals: { probe: () => null, answerable: () => true },
		});
		try {
			for (const [args, ms] of [
				[["--timeout", "3600"], 3_540_000],
				[[], 540_000],
			] as const) {
				const pending = nextPending(daemon.service);
				const h = runHook(home, input(), [...args]);
				const ap = await pending;
				expect(ap.expiresAt - ap.createdAt).toBe(ms);
				h.child.kill("SIGTERM");
				await h.done;
			}
		} finally {
			await daemon.stop();
			cleanup();
		}
	}, 30_000);

	test("no daemon: exits 0 at once with no output", async () => {
		const home = mkdtempSync(join(tmpdir(), "pulsar-nodaemon-"));
		const r = await runHook(home, input()).done;
		expect(r).toMatchObject({ code: 0, out: "", err: "" });
		expect(r.ms).toBeLessThan(3000);
	});

	test("bad or foreign input: no output", async () => {
		const { daemon, home, cleanup } = await startDaemon();
		try {
			for (const stdin of [
				"not json",
				input({ hook_event_name: "PreToolUse" }),
				input({ tool_input: null }),
				"",
			]) {
				const r = await runHook(home, stdin).done;
				expect(r).toMatchObject({ code: 0, out: "" });
			}
		} finally {
			await daemon.stop();
			cleanup();
		}
	}, 20_000);
});

describe("a prompt from another session id of a Claude process (a teammate, a switch)", () => {
	test("the scan leaves its agent while the prompt is pending; answering clears needs-you", async () => {
		const claudeDir = mkdtempSync(join(tmpdir(), "pulsar-hook-claude-"));
		mkdirSync(join(claudeDir, "sessions"));
		// The hook runs as this process's child: its parent pid is this process.
		writeFileSync(
			join(claudeDir, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId: "lead-sess",
				cwd: "/tmp/repo",
				name: "lead",
				status: "waiting",
				waitingFor: "permission prompt",
			}),
		);
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		const { daemon, home, cleanup } = await startDaemon({
			approvals: { probe: () => null, answerable: () => true },
		});
		try {
			const service = daemon.service;
			const auth = await enroll(service);
			const scan = () => service.registry.runScan("claude", claude.scan!);
			await scan();
			const pending = nextPending(service);
			const run = runHook(home, input());
			const a = await pending;
			expect(a.agentId).toBe("claude:hook-sess");
			await new Promise((r) => setTimeout(r, 5));
			await scan();
			// Still there, still waiting on the user, still answerable.
			expect(service.registry.get("claude:hook-sess")?.status).not.toBe("gone");
			expect(service.registry.needsYou("claude:hook-sess")?.reason).toBe(
				"approval",
			);
			expect(service.registry.needsYou("claude:lead-sess")).toBeNull();
			await decide(service, auth, a.requestId, "allow-once");
			const r = await run.done;
			expect(JSON.parse(r.out).hookSpecificOutput.decision).toEqual({
				behavior: "allow",
			});
			expect(service.registry.needsYou("claude:hook-sess")).toBeNull();
			// Claude runs the tool: the record leaves `waiting`.
			writeFileSync(
				join(claudeDir, "sessions", `${process.pid}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId: "lead-sess",
					cwd: "/tmp/repo",
					name: "lead",
					status: "busy",
				}),
			);
			// Once the hook is done, the extra id folds into the process's agent.
			await new Promise((r) => setTimeout(r, 5));
			await scan();
			expect(service.registry.get("claude:hook-sess")).toBeUndefined();
			expect(
				service.registry
					.live()
					.filter((x) => x.pid === process.pid)
					.map((x) => x.id),
			).toEqual(["claude:lead-sess"]);
			expect(service.registry.needsYou("claude:lead-sess")).toBeNull();
		} finally {
			await daemon.stop();
			cleanup();
			restoreEnv("CLAUDE_CONFIG_DIR", previous);
			rmSync(claudeDir, { recursive: true, force: true });
		}
	}, 30_000);
});
