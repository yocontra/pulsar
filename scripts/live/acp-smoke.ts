// Run from the terminal signed in to the provider. Use an isolated Pulsar
// daemon and workspace while leaving the vendor's normal login available.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
let diagnostics = "";
let output = "";
try {
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		diagnostics = (diagnostics + chunk).slice(-4096);
		if (!ready && /^ACP session .+$/m.test(diagnostics)) {
			ready = true;
			if (sessionOnly) child.kill("SIGTERM");
			else child.stdin.write(`Reply with exactly ${token}. Use no tools.\n`);
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
	if (!ready || (!sessionOnly && !received))
		throw new Error(
			`${provider.label} did not complete the smoke test. ${diagnostics.slice(-500)}`,
		);
	console.log(
		sessionOnly
			? `${provider.label}: managed session opened`
			: `${provider.label}: managed session opened and returned ${token}`,
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
