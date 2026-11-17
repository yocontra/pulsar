import { existsSync } from "node:fs";
import { DaemonClient } from "../client.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { VERSION } from "../version.ts";
import { CLIENTS } from "./clients.ts";

interface Status {
	version: string;
	protocol: number;
	pid: number;
	agents: number;
}

async function latestVersion(): Promise<string | null> {
	try {
		const res = await fetch("https://registry.npmjs.org/pulsar/latest", {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return null;
		return ((await res.json()) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

/** True when semver `a` is newer than `b` (prereleases count as older). */
export function newer(a: string, b: string): boolean {
	const parse = (v: string) => {
		const [core, pre] = v.split("-", 2);
		return {
			nums: (core ?? "").split(".").map((n) => Number(n) || 0),
			pre: pre ?? null,
		};
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	if (x.pre === y.pre) return false;
	if (x.pre === null) return true;
	if (y.pre === null) return false;
	return x.pre > y.pre;
}

/** Checks the daemon and every harness integration. Returns an exit code. */
export async function runDoctor(
	opts: { quiet?: boolean } = {},
): Promise<number> {
	let problems = 0;
	const ok = (msg: string) => console.log(`  ✓ ${msg}`);
	const bad = (msg: string) => {
		problems++;
		console.log(`  ✗ ${msg}`);
	};
	const note = (msg: string) => console.log(`  · ${msg}`);

	console.log(`pulsar ${VERSION} doctor`);
	const client = new DaemonClient();
	try {
		await client.connect(true);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const s = await client.call<Status>("status");
		ok(`daemon ${s.version} running (pid ${s.pid}), ${s.agents} live agent(s)`);
		if (s.version !== VERSION)
			note(
				`daemon runs ${s.version}; it switches to ${VERSION} after \`pulsar stop\``,
			);
		client.close();
	} catch (e) {
		bad(`daemon: ${(e as Error).message}`);
	}

	for (const c of CLIENTS) {
		if (!c.detect()) continue;
		if (c.configured()) ok(`${c.label}: configured`);
		else
			note(
				`${c.label}: found, not configured (run \`pulsar setup --client ${c.id}\`)`,
			);
	}

	if (!existsSync(process.execPath))
		bad(`node binary ${process.execPath} is missing; re-run \`pulsar setup\``);

	if (!opts.quiet) {
		const latest = await latestVersion();
		if (latest && newer(latest, VERSION))
			note(`pulsar ${latest} is available: run \`npx pulsar@latest setup\``);
	}
	return problems ? 1 : 0;
}
