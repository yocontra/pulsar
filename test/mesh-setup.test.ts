import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult, TailscaleRunner } from "../src/http/identity.ts";
import {
	meshOutro,
	parseTailscaleState,
	peerLine,
	runMeshSetup,
} from "../src/setup/mesh.ts";
import {
	type MeshFacts,
	meshChecks,
	parseLsofListen,
} from "../src/setup/mesh-doctor.ts";
import {
	type CommandResult,
	installService,
	LAUNCHD_LABEL,
	launchdPlist,
	plistArgs,
	readServiceRecord,
	removeService,
	type ServiceEnv,
	serviceStatus,
	serviceVariables,
	systemdUnit,
	unitArgs,
} from "../src/setup/service.ts";
import type { AppStatus } from "../src/types.ts";

/** A fake machine: HOME, state and install folders in a temp dir; every command stubbed. */
function fakeEnv(
	platform: NodeJS.Platform = "darwin",
	handler: (cmd: string, args: string[]) => CommandResult = () => ({
		ok: true,
		stdout: "",
		stderr: "",
	}),
) {
	const root = mkdtempSync(join(tmpdir(), "pulsar-mesh-"));
	const calls: string[] = [];
	const env: ServiceEnv = {
		platform,
		home: join(root, "home"),
		uid: 501,
		node: process.execPath,
		installDir: join(root, "install", "current"),
		stateDir: join(root, "state"),
		env: serviceVariables(
			{ PULSAR_HOME: join(root, "state"), HOME: "ignored" },
			process.execPath,
		),
		run: async (cmd, args) => {
			calls.push([cmd, ...args].join(" "));
			return handler(cmd, args);
		},
		wait: async () => {},
	};
	mkdirSync(env.home, { recursive: true });
	mkdirSync(env.stateDir, { recursive: true });
	mkdirSync(join(env.installDir, "dist"), { recursive: true });
	writeFileSync(join(env.installDir, "dist", "cli.js"), "");
	return { env, calls, root };
}

const OK: CommandResult = { ok: true, stdout: "", stderr: "" };
const FAIL: CommandResult = { ok: false, stdout: "", stderr: "not found" };

describe("service files", () => {
	test("launchd plist runs the current install as a kept-alive service", () => {
		const { env } = fakeEnv();
		const plist = launchdPlist(env);
		expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
		expect(plistArgs(plist)).toEqual([
			process.execPath,
			join(env.installDir, "dist", "cli.js"),
			"daemon",
			"--service",
		]);
		expect(plist).toMatch(
			/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
		);
		expect(plist).toMatch(
			/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/,
		);
		expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(plist).toContain(join(env.stateDir, "service.log"));
		expect(plist).toContain("/Applications/Tailscale.app/Contents/MacOS");
		expect(plist).toContain("<key>PULSAR_HOME</key>");
		// Only pulsar/XDG variables and PATH, never the whole environment.
		expect(plist).not.toContain("ignored");
	});

	test("systemd unit restarts on failure and quotes ExecStart", () => {
		const { env } = fakeEnv("linux");
		env.node = "/opt/my node/bin/node";
		const unit = systemdUnit(env);
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain("WantedBy=default.target");
		expect(unitArgs(unit)).toEqual([
			"/opt/my node/bin/node",
			"--max-semi-space-size=2",
			join(env.installDir, "dist", "cli.js"),
			"daemon",
			"--service",
		]);
		// Bun takes no V8 flags.
		env.node = "/opt/bun/bin/bun";
		expect(unitArgs(systemdUnit(env))).toEqual([
			"/opt/bun/bin/bun",
			join(env.installDir, "dist", "cli.js"),
			"daemon",
			"--service",
		]);
	});
});

describe("service install", () => {
	test("launchd: install, then reinstall restarts, then a change reloads", async () => {
		let loaded = false;
		const { env, calls } = fakeEnv("darwin", (cmd, args) => {
			if (cmd !== "launchctl") return OK;
			if (args[0] === "print") return loaded ? OK : FAIL;
			if (args[0] === "bootstrap") loaded = true;
			if (args[0] === "bootout") loaded = false;
			return OK;
		});
		const first = await installService(env);
		expect(first.change).toBe("installed");
		expect(first.file).toBe(
			join(env.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
		);
		expect(calls).toContain(`launchctl bootstrap gui/501 ${first.file}`);
		expect(readServiceRecord(env.stateDir)).toEqual({
			kind: "launchd",
			file: first.file,
		});

		calls.length = 0;
		const again = await installService(env);
		expect(again.change).toBe("restarted");
		expect(calls).toEqual([
			`launchctl print gui/501/${LAUNCHD_LABEL}`,
			`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`,
		]);

		calls.length = 0;
		env.node = "/usr/local/bin/node";
		const changed = await installService(env);
		expect(changed.change).toBe("updated");
		expect(calls).toContain(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
		expect(calls.at(-1)).toBe(`launchctl bootstrap gui/501 ${first.file}`);
		expect(plistArgs(readFileSync(first.file, "utf8"))[0]).toBe(
			"/usr/local/bin/node",
		);
	});

	test("launchd: bootstrap is retried while the old instance drains", async () => {
		let tries = 0;
		const { env } = fakeEnv("darwin", (_cmd, args) => {
			if (args[0] === "print") return FAIL;
			if (args[0] === "bootstrap")
				return ++tries < 3
					? { ok: false, stdout: "", stderr: "Bootstrap failed: 5" }
					: OK;
			return OK;
		});
		await installService(env);
		expect(tries).toBe(3);
	});

	test("systemd: reload, enable, restart; status; remove", async () => {
		const { env, calls } = fakeEnv("linux", (cmd, args) =>
			cmd === "systemctl" && args[1] === "show"
				? {
						ok: true,
						stdout: "LoadState=loaded\nActiveState=active\nMainPID=4242\n",
						stderr: "",
					}
				: OK,
		);
		const r = await installService(env);
		expect(r.file).toBe(
			join(env.home, ".config", "systemd", "user", "pulsar.service"),
		);
		expect(calls).toEqual([
			"systemctl --user daemon-reload",
			"systemctl --user enable pulsar.service",
			"systemctl --user restart pulsar.service",
		]);
		const st = await serviceStatus(env);
		expect(st).toMatchObject({ loaded: true, running: true, pid: 4242 });
		expect(st?.args[1]).toBe(join(env.installDir, "dist", "cli.js"));

		calls.length = 0;
		expect(await removeService(env)).toBe(r.file);
		expect(existsSync(r.file)).toBe(false);
		expect(calls).toEqual([
			"systemctl --user disable --now pulsar.service",
			"systemctl --user daemon-reload",
		]);
		expect(readServiceRecord(env.stateDir)).toBeNull();
	});

	test("systemd distinguishes an unavailable user bus from a missing unit", async () => {
		let result = { ok: false, stdout: "", stderr: "Failed to connect to bus" };
		const { env } = fakeEnv("linux", (_, args) =>
			args[1] === "show" ? result : OK,
		);
		await installService(env);
		expect(await serviceStatus(env)).toMatchObject({
			loaded: null,
			running: null,
			inspectionError: result.stderr,
		});
		result = { ok: false, stdout: "LoadState=not-found", stderr: "" };
		expect(await serviceStatus(env)).toMatchObject({
			loaded: false,
			running: false,
		});
	});

	test("only the service recorded in this state folder is touched", async () => {
		const { env, calls } = fakeEnv("darwin");
		// A plist from another install (the user's real one, say) without our record.
		mkdirSync(join(env.home, "Library", "LaunchAgents"), { recursive: true });
		const file = join(
			env.home,
			"Library",
			"LaunchAgents",
			`${LAUNCHD_LABEL}.plist`,
		);
		writeFileSync(file, "theirs");
		expect(await removeService(env)).toBeNull();
		expect(await serviceStatus(env)).toBeNull();
		expect(existsSync(file)).toBe(true);
		expect(calls).toEqual([]);
	});

	test("launchd remove boots out and deletes the plist", async () => {
		const { env, calls } = fakeEnv("darwin");
		const r = await installService(env);
		calls.length = 0;
		await removeService(env);
		expect(calls).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
		expect(existsSync(r.file)).toBe(false);
	});
});

const DNS = "studio.tail1234.ts.net";

function status(over: Record<string, unknown> = {}) {
	return {
		Version: "1.104.7-tabc",
		BackendState: "Running",
		Self: {
			DNSName: `${DNS}.`,
			HostName: "studio",
			TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
			UserID: 7,
		},
		User: { "7": { LoginName: "me@example.com" } },
		CurrentTailnet: { MagicDNSEnabled: true },
		CertDomains: [DNS],
		Peer: {
			a: {
				DNSName: "laptop.tail1234.ts.net.",
				OS: "macOS",
				Online: true,
				UserID: 7,
			},
			b: {
				DNSName: "iphone.tail1234.ts.net.",
				OS: "iOS",
				Online: false,
				UserID: 7,
			},
			c: {
				DNSName: "box.tail1234.ts.net.",
				OS: "linux",
				Online: true,
				UserID: 99,
				Tags: ["tag:server"],
			},
			d: {
				DNSName: "friend.tail1234.ts.net.",
				OS: "linux",
				Online: true,
				UserID: 12,
			},
		},
		...over,
	};
}

/** A Tailscale CLI that answers from a list of `status` states, one per call. */
function fakeTailscale(
	states: Array<RunResult | Record<string, unknown>>,
	cert: (args: string[]) => RunResult = (args) => {
		writeFileSync(args[2]!, "CERT");
		writeFileSync(args[4]!, "KEY", { mode: 0o644 });
		return { ok: true, stdout: "", stderr: "" };
	},
): { run: TailscaleRunner; calls: string[][] } {
	const calls: string[][] = [];
	let i = 0;
	const run: TailscaleRunner = async (args) => {
		calls.push(args);
		if (args[0] === "cert") return cert(args);
		// No prefs: the control server is told from the MagicDNS suffix.
		if (args[0] === "debug") return { ok: false, stdout: "", stderr: "" };
		const s = states[Math.min(i++, states.length - 1)]!;
		if ("ok" in s && typeof s.ok === "boolean") return s as RunResult;
		return { ok: true, stdout: JSON.stringify(s), stderr: "" };
	};
	return { run, calls };
}

const helloFetch = (async (url: string | URL | Request) => {
	// Peers answer the federation hello (what the daemon's discovery reads).
	if (
		String(url).startsWith("https://laptop.") &&
		String(url).includes("/fed/v1/hello")
	)
		return new Response(
			JSON.stringify({
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "2.0.0",
				machineId: "m-laptop",
				name: "laptop",
				port: 7337,
			}),
		);
	if (String(url).startsWith(`https://${DNS}:`))
		return new Response(
			JSON.stringify({ version: "2.0.0", machine: "studio" }),
		);
	throw new Error("unreachable");
}) as typeof fetch;

function meshDeps(
	ts: TailscaleRunner,
	opts: { enters?: boolean[]; platform?: NodeJS.Platform } = {},
) {
	const { env, calls, root } = fakeEnv(
		opts.platform ?? "darwin",
		(cmd, args) =>
			cmd === "/usr/bin/pmset" && args[1] === "batt"
				? { ok: true, stdout: "-InternalBattery-0 (id=1) 80%", stderr: "" }
				: cmd === "launchctl" && args[0] === "print"
					? FAIL
					: OK,
	);
	const lines: string[] = [];
	const prompts: string[] = [];
	const enters = [...(opts.enters ?? [])];
	let remote = false;
	return {
		lines,
		prompts,
		calls,
		env,
		remote: () => remote,
		deps: {
			tailscale: ts,
			run: env.run,
			fetch: helloFetch,
			service: env,
			port: 7337,
			log: (l: string) => lines.push(l),
			waitEnter: async (p: string) => {
				prompts.push(p);
				return enters.shift() ?? false;
			},
			enableRemote: () => {
				remote = true;
			},
			certDir: join(root, "tls"),
		},
	};
}

describe("pulsar mesh on", () => {
	for (const [name, s, fix] of [
		[
			"missing",
			{ ok: false, stdout: "", stderr: "not installed", missing: true },
			"Tailscale is not installed",
		],
		[
			"not running",
			{
				ok: false,
				stdout: "",
				stderr: "failed to connect to local tailscaled",
			},
			"Could not verify Tailscale status (failed to connect to local tailscaled). Check with `tailscale status`.",
		],
		[
			"stopped",
			{ BackendState: "Stopped" },
			"Tailscale is disconnected. Connect it: tailscale up",
		],
		[
			"logged out",
			{ BackendState: "NeedsLogin" },
			"Tailscale is not signed in. Sign in: tailscale login",
		],
		[
			"MagicDNS off",
			status({ CurrentTailnet: { MagicDNSEnabled: false } }),
			"MagicDNS is off. Turn it on at https://login.tailscale.com/admin/dns",
		],
	] as const) {
		test(`${name}: shows the fix and stops without a terminal`, async () => {
			const { run } = fakeTailscale([s]);
			const m = meshDeps(run);
			const r = await runMeshSetup(m.deps);
			expect(r.ok).toBe(false);
			expect(m.lines.join("\n")).toContain(fix);
			expect(m.prompts).toEqual(["Press Enter to check again"]);
			expect(m.remote()).toBe(false);
			expect(readServiceRecord(m.env.stateDir)).toBeNull();
		});
	}

	test("logged out, then signed in after Enter, certs off then on: completes", async () => {
		const certsOff = status({ CertDomains: null });
		const { run, calls } = fakeTailscale([
			{ BackendState: "NeedsLogin" },
			certsOff,
			status(),
		]);
		const m = meshDeps(run, { enters: [true, true] });
		const r = await runMeshSetup(m.deps);
		const out = m.lines.join("\n");
		expect(r.ok).toBe(true);
		expect(r.url).toBe(`https://${DNS}:7337/`);
		expect(out).toContain("HTTPS certificates are off");
		expect(out).toContain("https://login.tailscale.com/admin/dns");
		expect(m.prompts).toHaveLength(2);
		expect(calls.filter((c) => c[0] === "cert")).toHaveLength(1);
		const key = join(m.deps.certDir, `${DNS}.key`);
		expect(statSync(key).mode & 0o777).toBe(0o600);
		expect(m.remote()).toBe(true);
		expect(r.service?.change).toBe("installed");
		expect(m.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
		// The pool: same-user peers (probed), the tagged node, not the other user.
		expect(out).toContain("laptop (macOS): Pulsar 2.0.0");
		expect(out).toContain("iphone (iOS): offline");
		expect(out).toContain("pulsar mesh allow box");
		expect(out).not.toContain("friend");
		expect(out).toContain("lid closed");
		expect(out).toContain("✓ app answers (Pulsar 2.0.0)");
		// The URL and QR code come at the very end of setup, from meshOutro.
		expect(out).not.toContain("Open the app");
		const end: string[] = [];
		await meshOutro(r.url!, (l) => end.push(l));
		const tail = end.join("\n");
		expect(tail).toContain(`Open the app: https://${DNS}:7337/`);
		expect(tail).toContain("Add to Home Screen");
		expect(tail).toMatch(/[█▀▄]/);
	});

	test("tailscale cert says certs are unsupported: links the DNS page and re-checks", async () => {
		let n = 0;
		const { run } = fakeTailscale([status()], (args) => {
			if (n++ === 0)
				return {
					ok: false,
					stdout: "",
					stderr:
						"500 Internal Server Error: your Tailscale account does not support getting TLS certs",
				};
			writeFileSync(args[2]!, "CERT");
			writeFileSync(args[4]!, "KEY");
			return { ok: true, stdout: "", stderr: "" };
		});
		const m = meshDeps(run, { enters: [true] });
		const r = await runMeshSetup(m.deps);
		expect(r.ok).toBe(true);
		expect(m.lines.join("\n")).toContain(
			"https://login.tailscale.com/admin/dns",
		);
		expect(m.prompts).toHaveLength(1);
	});

	test("no systemd user session (a container): the rest of setup still runs", async () => {
		const { run } = fakeTailscale([status()]);
		const m = meshDeps(run, { platform: "linux" });
		const realRun = m.env.run;
		m.deps.service = {
			...m.env,
			run: async (cmd, args) =>
				cmd === "systemctl"
					? { ok: false, stdout: "", stderr: "systemctl: not found" }
					: realRun(cmd, args),
		};
		const r = await runMeshSetup(m.deps);
		const out = m.lines.join("\n");
		expect(r.ok).toBe(true);
		expect(r.url).toBe(`https://${DNS}:7337/`);
		expect(r.service).toBeUndefined();
		expect(out).toContain("no service manager here");
		expect(out).toContain("pulsar daemon --service");
		expect(m.remote()).toBe(true);
		expect(readServiceRecord(m.env.stateDir)).toBeNull();
	});

	test("a tagged node cannot host the app", async () => {
		const { run } = fakeTailscale([status({ User: {} })]);
		const m = meshDeps(run);
		expect((await runMeshSetup(m.deps)).ok).toBe(false);
		expect(m.lines.join("\n")).toContain("tagged node");
	});

	test("running setup twice restarts the service instead of duplicating it", async () => {
		const { run } = fakeTailscale([status()]);
		let loaded = false;
		const m = meshDeps(run);
		m.env.run = async (cmd, args) => {
			m.calls.push([cmd, ...args].join(" "));
			if (cmd === "launchctl" && args[0] === "print") return loaded ? OK : FAIL;
			if (cmd === "launchctl" && args[0] === "bootstrap") loaded = true;
			return OK;
		};
		m.deps.run = m.env.run;
		expect((await runMeshSetup(m.deps)).service?.change).toBe("installed");
		expect((await runMeshSetup(m.deps)).service?.change).toBe("restarted");
		expect(
			m.calls.filter((c) => c.startsWith("launchctl bootstrap")),
		).toHaveLength(1);
	});
});

describe("tailscale state", () => {
	test("peers: same user, tagged, other users", () => {
		const s = parseTailscaleState(status());
		if (s.kind !== "running") throw new Error(s.kind);
		expect(s.magicDns).toBe(true);
		expect(s.version).toBe("1.104.7");
		expect(s.peers.map((p) => [p.name, p.sameUser, p.tagged])).toEqual([
			["box", false, true],
			["friend", false, false],
			["iphone", true, false],
			["laptop", true, false],
		]);
		expect(peerLine({ peer: s.peers[3]!, pulsar: null })).toBe(
			"laptop (macOS): online, no Pulsar (run `npx pulsar@2 setup` there)",
		);
		expect(
			peerLine({ peer: { ...s.peers[2]!, online: true }, pulsar: null }),
		).toBe("iphone (iOS): online; open the Pulsar app there in a browser");
	});

	test("peer lines use the federation hello and the daemon's link state", () => {
		const peer = {
			name: "studio",
			dnsName: "studio.t.ts.net",
			os: "macOS",
			online: true,
			sameUser: true,
			tagged: false,
		};
		const pulsar = {
			version: "2.0.0",
			machine: "studio",
			fedProtocol: [1, 1] as [number, number],
			port: 7337,
		};
		expect(peerLine({ peer, pulsar })).toBe("studio (macOS): Pulsar 2.0.0");
		expect(peerLine({ peer, pulsar }, { link: "tailnet" })).toBe(
			"studio (macOS): Pulsar 2.0.0, linked",
		);
		expect(
			peerLine(
				{ peer, pulsar: { ...pulsar, port: 8443 } },
				{
					link: "daemon-down",
					reason: "Pulsar on studio is not answering",
				},
			),
		).toBe(
			"studio (macOS): Pulsar 2.0.0 on port 8443, Pulsar on studio is not answering",
		);
		expect(peerLine({ peer, pulsar: { ...pulsar, fedProtocol: [0, 0] } })).toBe(
			"studio (macOS): Pulsar 2.0.0, upgrade Pulsar on studio",
		);
		expect(peerLine({ peer, pulsar: { ...pulsar, fedProtocol: [5, 6] } })).toBe(
			"studio (macOS): Pulsar 2.0.0, upgrade Pulsar on this machine",
		);
		const tagged = { ...peer, name: "ci", sameUser: false, tagged: true };
		expect(peerLine({ peer: tagged, pulsar })).toContain(
			"pulsar mesh allow ci",
		);
		expect(peerLine({ peer: tagged, pulsar }, { link: "tailnet" }, true)).toBe(
			"ci (macOS): Pulsar 2.0.0, linked",
		);
	});

	test("lsof listeners", () => {
		expect(
			parseLsofListen(
				"p123\nf20\nn100.1.2.3:7337\nf21\nn[fd7a:115c:a1e0::1]:7337\n",
			),
		).toEqual(["100.1.2.3", "fd7a:115c:a1e0::1"]);
		expect(parseLsofListen("p1\nf3\nn*:7337\n")).toEqual(["*"]);
	});
});

describe("pulsar doctor: mesh checks", () => {
	function selfSignedCert(dir: string, days: number) {
		mkdirSync(dir, { recursive: true });
		const cert = join(dir, `${DNS}.crt`);
		const key = join(dir, `${DNS}.key`);
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-nodes",
				"-subj",
				`/CN=${DNS}`,
				"-days",
				String(days),
				"-keyout",
				key,
				"-out",
				cert,
			],
			{ stdio: "ignore" },
		);
		// `tailscale cert` writes the key 0600; openssl follows the umask.
		chmodSync(key, 0o600);
		return { cert, key };
	}

	let lastFacts: MeshFacts | null = null;
	async function doctor(opts: {
		ts?: RunResult | Record<string, unknown>;
		lsof?: string;
		running?: boolean;
		launchError?: string;
		remoteOn?: boolean;
		certDays?: number;
		installed?: boolean;
		otherCli?: boolean;
		app?: AppStatus;
	}) {
		const { run } = fakeTailscale([opts.ts ?? status()]);
		const { env, root } = fakeEnv("darwin", (cmd, args) => {
			if (cmd === "lsof")
				return { ok: !!opts.lsof, stdout: opts.lsof ?? "", stderr: "" };
			if (cmd === "launchctl" && args[0] === "print")
				return opts.launchError || opts.running === false
					? {
							...FAIL,
							stderr:
								opts.launchError ??
								'Could not find service "io.github.yocontra.pulsar" in domain for user gui: 501',
						}
					: {
							ok: true,
							stdout: "\tstate = running\n\tpid = 777\n",
							stderr: "",
						};
			return OK;
		});
		const certDir = join(root, "tls");
		if (opts.certDays !== undefined) selfSignedCert(certDir, opts.certDays);
		if (opts.installed !== false) {
			await installService(env);
			if (opts.otherCli) env.installDir = join(root, "elsewhere");
		}
		const lines: string[] = [];
		lastFacts = await meshChecks(
			{
				tailscale: run,
				run: env.run,
				fetch: helloFetch,
				service: env,
				remoteOn: opts.remoteOn ?? true,
				port: 7337,
				certDir,
				...(opts.app ? { app: async () => opts.app ?? null } : {}),
			},
			{
				ok: (m) => lines.push(`✓ ${m}`),
				bad: (m, f) => lines.push(`✗ ${f ? `${m}: ${f}` : m}`),
				note: (m, f) => lines.push(`· ${f ? `${m}: ${f}` : m}`),
			},
		);
		return lines;
	}

	test("healthy node", async () => {
		const lines = await doctor({
			certDays: 90,
			lsof: "p1\nn100.101.102.103:7337\nn[fd7a:115c:a1e0::1]:7337\n",
		});
		expect(lines).toEqual([
			`✓ Tailscale 1.104.7: ${DNS} (me@example.com), control server tailscale.com`,
			"✓ MagicDNS on",
			"✓ HTTPS certificates on",
			expect.stringMatching(/^✓ node certificate valid for (89|90) days$/),
			"✓ app on (port 7337)",
			"✓ background service running (pid 777)",
			"✓ HTTPS on Tailscale addresses only (100.101.102.103, fd7a:115c:a1e0::1:7337)",
			"· box (linux): tagged device; let it in with `pulsar mesh allow box`",
			"· iphone (iOS): offline",
			"✓ laptop (macOS): Pulsar 2.0.0",
		]);
		// The app's machine facts come from the same run.
		expect(lastFacts).toEqual({
			tailscale: {
				state: "running",
				version: "1.104.7",
				dnsName: DNS,
				magicDns: true,
			},
			certDays: expect.any(Number),
		});
		expect(lastFacts!.certDays).toBeGreaterThanOrEqual(89);
	});

	test("unreadable Tailscale preferences and launchd domain are unknown", async () => {
		const lines = await doctor({
			ts: { ok: false, stdout: "", stderr: "Failed to load preferences." },
			launchError: "Could not print domain: 141: Reentrancy avoided",
			lsof: "p1\nn100.101.102.103:7337\n",
		});
		expect(lines).toContain(
			"· Could not verify Tailscale status (Failed to load preferences.). Check with `tailscale status`.",
		);
		expect(lastFacts?.tailscale.state).toBe("unknown");
		expect(lines).toContain(
			"· Could not verify background service status (Could not print domain: 141: Reentrancy avoided)",
		);
		expect(lines).toContain(
			"✓ HTTPS on Tailscale addresses only (100.101.102.103:7337)",
		);
	});

	test("problems each get a one-line fix", async () => {
		const lines = await doctor({
			ts: status({ CertDomains: [] }),
			running: false,
			lsof: "p1\nn*:7337\n",
			otherCli: true,
		});
		const text = lines.join("\n");
		expect(text).toContain(
			"✗ HTTPS certificates are off: turn them on at https://login.tailscale.com/admin/dns",
		);
		expect(text).toContain("✗ no node certificate yet: run `pulsar mesh on`");
		expect(text).toContain("✗ background service not loaded");
		expect(text).toContain("not the current install: run `pulsar mesh on`");
		expect(text).toContain("✗ port 7337 listens outside Tailscale: *");
	});

	test("expiring certificate is a note; tailscale missing is a failure", async () => {
		expect((await doctor({ certDays: 3 })).join("\n")).toMatch(
			/· node certificate expires in [23] day\(s\)/,
		);
		const missing = await doctor({
			ts: { ok: false, stdout: "", stderr: "", missing: true },
			installed: false,
		});
		expect(missing[0]).toContain("✗ Tailscale is not installed");
		expect(missing).toContain(
			"✗ background service not installed: run `pulsar mesh on`",
		);
	});

	test("nothing listens while the daemon waits for Tailscale: says so, and that it retries", async () => {
		const now = Date.now();
		const lines = await doctor({
			certDays: 90,
			lsof: "p1\n",
			app: {
				state: "retrying",
				error:
					"Tailscale is not running or not logged in (backend state Stopped)",
				tailscale: true,
				attempt: 4,
				since: now - 60_000,
				retryAt: now + 15_000,
			},
		});
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^✗ nothing listens on port 7337: the daemon is waiting for Tailscale \(next try in 1[45] s\)$/,
			),
		);
		// An older daemon (no app state): the plain line.
		expect(await doctor({ certDays: 90, lsof: "p1\n" })).toContain(
			"✗ nothing listens on port 7337",
		);
	});

	test("with the app off, mesh problems are notes", async () => {
		const lines = await doctor({ remoteOn: false, installed: false });
		expect(lines.some((l) => l.startsWith("✗"))).toBe(false);
		expect(lines).toContain(
			"· app off on this device: run `pulsar mesh on` to join the mesh",
		);
	});
});

describe("pulsar mesh on, on Headscale", () => {
	const HS = "studio.mesh.corp.example";
	const FIX = join(import.meta.dir, "fixtures", "headscale");
	/** Inside the fixture certificate's validity. */
	const NOW = Date.parse("2027-01-15T00:00:00Z");
	const hsStatus = () =>
		status({
			Self: {
				DNSName: `${HS}.`,
				HostName: "studio",
				TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
				UserID: 1,
			},
			User: { "1": { LoginName: "ada" } },
			MagicDNSSuffix: "mesh.corp.example",
			CurrentTailnet: { MagicDNSEnabled: true },
			CertDomains: null,
			Peer: {
				a: {
					DNSName: "laptop.mesh.corp.example.",
					OS: "linux",
					Online: true,
					UserID: 1,
				},
			},
		});

	test("no certificate of your own: says to bring one, never runs tailscale cert", async () => {
		const { run, calls } = fakeTailscale([hsStatus()]);
		const m = meshDeps(run);
		const r = await runMeshSetup(m.deps);
		const out = m.lines.join("\n");
		expect(r.ok).toBe(false);
		expect(out).toContain("control server: a self-hosted control server");
		expect(out).toContain("pulsar mesh on --cert <file> --key <file>");
		expect(out).not.toContain("login.tailscale.com");
		expect(calls.filter((c) => c[0] === "cert")).toHaveLength(0);
		expect(m.remote()).toBe(false);
	});

	test("your own certificate: checked, saved, used instead of tailscale cert", async () => {
		const { run, calls } = fakeTailscale([hsStatus()]);
		const m = meshDeps(run);
		const dir = mkdtempSync(join(tmpdir(), "pulsar-hs-setup-"));
		const key = join(dir, "node.key");
		writeFileSync(key, readFileSync(join(FIX, "node.key")), { mode: 0o600 });
		const tls = {
			cert: join(FIX, "node.crt"),
			key,
			ca: join(FIX, "root.crt"),
		};
		const saved: unknown[] = [];
		const rps: string[] = [];
		const r = await runMeshSetup({
			...m.deps,
			tls,
			saveTls: (t) => saved.push(t),
			rpId: "corp.example",
			saveRpId: (rp) => rps.push(rp),
			now: NOW,
			appWaitTries: 1,
		});
		const out = m.lines.join("\n");
		rmSync(dir, { recursive: true, force: true });
		expect(out).toContain(`your certificate for ${HS}`);
		expect(r.ok).toBe(true);
		expect(r.url).toBe(`https://${HS}:7337/`);
		expect(saved).toEqual([tls]);
		expect(rps).toEqual(["corp.example"]);
		expect(calls.filter((c) => c[0] === "cert")).toHaveLength(0);
		expect(m.remote()).toBe(true);
	});

	test("a bad --rp-id or a certificate for another name stops before anything is saved", async () => {
		const { run } = fakeTailscale([hsStatus()]);
		const m = meshDeps(run);
		const rps: string[] = [];
		const bad = await runMeshSetup({
			...m.deps,
			rpId: "example",
			saveRpId: (rp) => rps.push(rp),
		});
		expect(bad.ok).toBe(false);
		expect(m.lines.join("\n")).toContain("public suffix");
		expect(rps).toEqual([]);

		const other = fakeTailscale([
			status({
				...hsStatus(),
				Self: { ...hsStatus().Self, DNSName: "other.mesh.corp.example." },
			}),
		]);
		const m2 = meshDeps(other.run);
		const saved: unknown[] = [];
		const r = await runMeshSetup({
			...m2.deps,
			tls: { cert: join(FIX, "node.crt"), key: join(FIX, "node.key") },
			saveTls: (t) => saved.push(t),
			now: NOW,
		});
		expect(r.ok).toBe(false);
		expect(m2.lines.join("\n")).toContain("not for other.mesh.corp.example");
		expect(saved).toEqual([]);
		expect(m2.remote()).toBe(false);
	});
});
