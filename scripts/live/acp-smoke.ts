// Run from the terminal signed in to the provider. Use an isolated Pulsar
// daemon and workspace while leaving the vendor's normal login available.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ACP_PROVIDERS } from "../../src/harnesses/acp-catalog.ts";

const provider = ACP_PROVIDERS.find((p) => p.id === process.argv[2]);
const sessionOnly = process.argv[3] === "--session-only";
if (!provider || process.argv.length !== (sessionOnly ? 4 : 3)) {
	throw new Error(
		"Usage: bun scripts/live/acp-smoke.ts <provider> [--session-only]",
	);
}
const scratch = await mkdtemp(join(tmpdir(), "pulsar-acp-check-"));
const cwd = join(scratch, "workspace");
await mkdir(cwd);
const cli = resolve(import.meta.dir, "../../src/cli.ts");
const env = {
	...process.env,
	PULSAR_HOME: join(scratch, "state"),
	PULSAR_INSTALL_ROOT: join(scratch, "install"),
	PULSAR_NO_SCAN: "1",
	PULSAR_NO_MESH: "1",
	PULSAR_USAGE_SCAN: "0",
};
const child = spawn(process.execPath, [cli, "acp", provider.id], {
	env,
	cwd,
	stdio: ["pipe", "pipe", "pipe"],
});
const ended = once(child, "close");
const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
const token = "PULSAR_ACP_OK";
let ready = false;
let received = false;
let send: Promise<void> | undefined;
let delivery = "";
let diagnostics = "";
let output = "";
try {
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		diagnostics = (diagnostics + chunk).slice(-4096);
		if (!ready && /^ACP session .+$/m.test(diagnostics)) {
			ready = true;
			if (sessionOnly) child.kill("SIGTERM");
			else {
				// This daemon contains only the smoke session. Use the operator's
				// normal delivery path to wake it without writing to its terminal.
				send = promisify(execFile)(
					process.execPath,
					[
						cli,
						"send",
						`harness=${provider.id}`,
						`Reply with exactly ${token}. Use no tools.`,
					],
					{ env, cwd, timeout: 15_000 },
				).then(
					({ stdout }) => {
						delivery = stdout.trim();
						if (!/sent via extension/.test(delivery)) child.kill("SIGTERM");
					},
					(error) => {
						delivery = error.message;
						child.kill("SIGTERM");
					},
				);
			}
		}
	});
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		output = (output + chunk).slice(-4096);
		if (!received && output.includes(token)) {
			received = true;
			child.kill("SIGTERM");
		}
	});
	await ended;
	await send;
	if (
		!ready ||
		(!sessionOnly && (!received || !/sent via extension/.test(delivery)))
	)
		throw new Error(
			`${provider.label} did not complete the smoke test. ${delivery} ${diagnostics.slice(-500)}`,
		);
	console.log(
		sessionOnly
			? `${provider.label}: managed session opened`
			: `${provider.label}: idle managed session woke and returned ${token}`,
	);
} finally {
	clearTimeout(timeout);
	const stop = spawn(process.execPath, [cli, "stop"], {
		env,
		cwd,
		stdio: "ignore",
	});
	await once(stop, "close");
	await rm(scratch, { recursive: true, force: true });
}
