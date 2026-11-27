import { existsSync } from "node:fs";
import { readPoolConfig } from "../federation/config.ts";
import {
	DEFAULT_FED_PORT,
	FED_PROTOCOL,
	negotiate,
	parseHello,
} from "../federation/protocol.ts";
import {
	isTailnetName,
	magicDnsSuffix,
	tailnetRpId,
} from "../federation/tailnet.ts";
import { appUrl, DEFAULT_PORT } from "../http/config.ts";
import {
	type ControlPlane,
	controlFromSuffix,
	controlLabel,
	readControlPlane,
} from "../http/control.ts";
import {
	BRING_CERT_HINT,
	certsDisabled,
	ENABLE_HTTPS_HINT,
	fetchCert,
	parseStatusSelf,
	type TailscaleRunner,
	type TailscaleSelf,
} from "../http/identity.ts";
import { inspectCert, type TlsFiles, trustCa } from "../http/tls.ts";
import type { Hello } from "../http/wire.ts";
import type { PoolMachine } from "../service/pool.ts";
import {
	type CommandRunner,
	type InstallResult,
	installService,
	type ServiceEnv,
	serviceManagerAvailable,
} from "./service.ts";

export const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
const ADMIN_MACHINES_URL = "https://login.tailscale.com/admin/machines";

export interface TailscalePeer {
	/** Short MagicDNS name. */
	name: string;
	/** `studio.tail1234.ts.net` (or `studio.<Headscale base domain>`). */
	dnsName: string;
	os: string;
	online: boolean;
	/** Signed in as the same Tailscale user as this node. */
	sameUser: boolean;
	/** A tagged node (no user); joins only with `pulsar mesh allow`. */
	tagged: boolean;
}

export type TailscaleState =
	| { kind: "missing" }
	| { kind: "unknown"; detail: string }
	| { kind: "stopped"; control?: ControlPlane }
	| { kind: "logged-out"; control?: ControlPlane }
	| { kind: "needs-approval"; control?: ControlPlane }
	| {
			kind: "running";
			self: TailscaleSelf;
			version: string;
			magicDns: boolean;
			peers: TailscalePeer[];
			/** This tailnet's MagicDNS suffix. */
			suffix: string | null;
			/** tailscale.com or a self-hosted control server (Headscale). */
			control: ControlPlane;
	  };

function stripDot(s: string) {
	return s.replace(/\.$/, "");
}

/** Parses `tailscale status --json` into the setup's view of Tailscale. */
export function parseTailscaleState(json: unknown): TailscaleState {
	const s = (json ?? {}) as {
		BackendState?: string;
		Version?: string;
		Self?: { UserID?: unknown };
		CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
		MagicDNSSuffix?: string;
		Peer?: Record<
			string,
			{
				DNSName?: string;
				HostName?: string;
				OS?: string;
				Online?: boolean;
				UserID?: unknown;
				Tags?: unknown;
			}
		> | null;
	};
	switch (s.BackendState) {
		case "Running":
			break;
		case "NeedsLogin":
			return { kind: "logged-out" };
		case "NeedsMachineAuth":
			return { kind: "needs-approval" };
		case "Stopped":
			return { kind: "stopped" };
		default:
			return {
				kind: "unknown",
				detail: `Tailscale is ${s.BackendState ?? "not answering"}`,
			};
	}
	const self = parseStatusSelf(json);
	if (!self)
		return {
			kind: "unknown",
			detail: "the running backend returned no device DNS name",
		};
	const owner = s.Self?.UserID;
	const peers: TailscalePeer[] = Object.values(s.Peer ?? {}).map((p) => {
		const dnsName = stripDot(p.DNSName ?? "");
		return {
			name: dnsName.split(".")[0] || (p.HostName ?? "?"),
			dnsName,
			os: p.OS ?? "",
			online: p.Online === true,
			sameUser: owner !== undefined && String(p.UserID) === String(owner),
			tagged: Array.isArray(p.Tags) && p.Tags.length > 0,
		};
	});
	peers.sort((a, b) => a.name.localeCompare(b.name));
	const suffix = magicDnsSuffix(self.dnsName);
	return {
		kind: "running",
		suffix,
		control: controlFromSuffix(suffix),
		self,
		version: (s.Version ?? "").split("-")[0] ?? "",
		// Older clients lack CurrentTailnet; a MagicDNS suffix means it is on.
		magicDns: s.CurrentTailnet
			? s.CurrentTailnet.MagicDNSEnabled === true
			: !!s.MagicDNSSuffix,
		peers,
	};
}

export async function readTailscale(
	run: TailscaleRunner,
): Promise<TailscaleState> {
	const r = await run(["status", "--json"], 5000);
	if (r.missing) return { kind: "missing" };
	let json: unknown = null;
	try {
		json = JSON.parse(r.stdout);
	} catch {}
	// `status` exits non-zero when stopped or logged out but still prints JSON.
	if (json && typeof json === "object" && "BackendState" in json) {
		const state = parseTailscaleState(json);
		if (state.kind === "missing" || state.kind === "unknown") return state;
		const control = await readControlPlane(
			run,
			state.kind === "running" ? state.suffix : null,
		);
		return { ...state, control };
	}
	return {
		kind: "unknown",
		detail: (r.stderr || r.stdout).trim().split("\n")[0] || "no answer",
	};
}

/** One line: what is wrong with Tailscale and how to fix it. Null when it runs. */
export function tailscaleFix(
	state: TailscaleState,
	platform: NodeJS.Platform,
): string | null {
	switch (state.kind) {
		case "running":
			return null;
		case "missing":
			return "Tailscale is not installed. Install it from https://tailscale.com/download and sign in.";
		case "unknown":
			return `Could not verify Tailscale status (${state.detail}). Check with \`tailscale status\`.`;
		case "stopped":
			return `Tailscale is disconnected. Connect it: tailscale up${platform === "darwin" ? " (or switch it on in the Tailscale app)" : ""}`;
		case "logged-out": {
			const server =
				state.control?.kind === "custom" && state.control.url
					? ` --login-server ${state.control.url}`
					: "";
			return `Tailscale is not signed in. Sign in: tailscale login${server}${platform === "darwin" ? " (or in the Tailscale app)" : ""}`;
		}
		case "needs-approval":
			return state.control?.kind === "custom"
				? `This device waits for approval on your control server (${controlLabel(state.control)}), e.g. \`headscale nodes register\``
				: `This device waits for approval in the Tailscale admin console: ${ADMIN_MACHINES_URL}`;
	}
}

/** The fix for MagicDNS being off, for this control server. */
export function magicDnsFix(control: ControlPlane): string {
	return control.kind === "custom"
		? "MagicDNS is off. Turn it on in the control server's config (Headscale: dns.magic_dns: true and a dns.base_domain)"
		: `MagicDNS is off. Turn it on at ${ADMIN_DNS_URL}`;
}

export interface PulsarProbe {
	version: string;
	machine: string;
	/** Federation protocol range (peers only, from `/fed/v1/hello`). */
	fedProtocol?: [number, number];
	/** The port it answered on. */
	port?: number;
}

/** Asks this node's own app (`GET /api/v1/hello`); null when nothing answers in time. */
async function probePulsar(
	dnsName: string,
	port: number,
	fetchFn: typeof fetch = fetch,
	timeoutMs = 1500,
): Promise<PulsarProbe | null> {
	try {
		const res = await fetchFn(`https://${dnsName}:${port}/api/v1/hello`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const h = (await res.json()) as Partial<Hello>;
		return typeof h.version === "string"
			? { version: h.version, machine: h.machine ?? dnsName.split(".")[0]! }
			: null;
	} catch {
		return null;
	}
}

/**
 * Asks a peer's pulsar the way the daemon's federation does
 * (`GET /fed/v1/hello`, the same parser), on the given port, then the
 * default. Null when nothing answers.
 */
export async function probePeerPulsar(
	dnsName: string,
	port: number,
	fetchFn: typeof fetch,
	timeoutMs: number,
	/** This tailnet's MagicDNS suffix (this node's, never the peer's word). */
	suffix: string | null,
): Promise<PulsarProbe | null> {
	// Like the daemon's federation: this tailnet's MagicDNS names only, never a redirect.
	if (!isTailnetName(dnsName, suffix)) return null;
	const name = dnsName.split(".")[0]!;
	for (const p of [...new Set([port, DEFAULT_FED_PORT])]) {
		try {
			const res = await fetchFn(`https://${dnsName}:${p}/fed/v1/hello`, {
				signal: AbortSignal.timeout(timeoutMs),
				redirect: "error",
			});
			if (!res.ok) continue;
			const h = parseHello(await res.json(), name);
			if (h)
				return {
					version: h.pulsarVersion,
					machine: h.name,
					fedProtocol: h.fedProtocol,
					port: h.port ?? p,
				};
		} catch {}
	}
	return null;
}

export interface PeerReport {
	peer: TailscalePeer;
	pulsar: PulsarProbe | null;
}

/**
 * Same-user and tagged peers, listed; only nodes in the pool are probed (your
 * own untagged nodes, and tagged nodes `pulsar mesh allow` let in).
 */
export async function probePeers(
	peers: TailscalePeer[],
	port: number,
	fetchFn: typeof fetch,
	allowed: string[] | undefined,
	/** This tailnet's MagicDNS suffix: only names under it are probed. */
	suffix: string | null,
): Promise<PeerReport[]> {
	const allow = allowed ?? readPoolConfig().allow;
	const relevant = peers.filter((p) => p.sameUser || p.tagged);
	const inPool = (p: TailscalePeer) =>
		(p.sameUser && !p.tagged) || allow.includes(p.name.toLowerCase());
	return Promise.all(
		relevant.map(async (peer) => ({
			peer,
			pulsar:
				peer.online && peer.dnsName && inPool(peer)
					? await probePeerPulsar(peer.dnsName, port, fetchFn, 1500, suffix)
					: null,
		})),
	);
}

/**
 * One line per peer, e.g. `studio (macOS): pulsar 2.0.0, linked`. `link`
 * is the running daemon's view of it (its federation), when known.
 */
export function peerLine(
	r: PeerReport,
	link?: Pick<PoolMachine, "link" | "reason">,
	allowed = false,
): string {
	const { peer } = r;
	const what = `${peer.name}${peer.os ? ` (${peer.os})` : ""}`;
	if (peer.tagged && !peer.sameUser && !allowed)
		return `${what}: tagged device; let it in with \`pulsar mesh allow ${peer.name}\``;
	if (!peer.online) return `${what}: offline`;
	if (!r.pulsar)
		return /^(ios|ipados|android)$/i.test(peer.os)
			? `${what}: online; open the Pulsar app there in a browser`
			: `${what}: online, no Pulsar (run \`npx pulsar@2 setup\` there)`;
	const skew =
		r.pulsar.fedProtocol &&
		negotiate(FED_PROTOCOL, r.pulsar.fedProtocol) === null
			? r.pulsar.fedProtocol[0] > FED_PROTOCOL[1]
				? "upgrade Pulsar on this machine"
				: `upgrade Pulsar on ${peer.name}`
			: null;
	const state = skew
		? skew
		: link?.link === "tailnet"
			? "linked"
			: link
				? (link.reason ?? link.link)
				: null;
	const port =
		r.pulsar.port && r.pulsar.port !== DEFAULT_FED_PORT
			? ` on port ${r.pulsar.port}`
			: "";
	return `${what}: Pulsar ${r.pulsar.version}${port}${state ? `, ${state}` : ""}`;
}

/**
 * A warning when this machine is a laptop that sleeps with the lid closed
 * (it then drops off the mesh). Null on desktops, servers, or when sleep is
 * turned off.
 */
async function laptopSleepWarning(
	run: CommandRunner,
	platform: NodeJS.Platform,
): Promise<string | null> {
	if (platform === "darwin") {
		const batt = await run("/usr/bin/pmset", ["-g", "batt"]);
		if (!batt.ok || !/InternalBattery/.test(batt.stdout)) return null;
		const g = await run("/usr/bin/pmset", ["-g"]);
		if (/^\s*SleepDisabled\s+1\b/m.test(g.stdout)) return null;
		return "This Mac is a laptop: with the lid closed it sleeps and drops off the mesh. Keep it open and on power, or run Pulsar on an always-on machine too.";
	}
	if (platform === "linux") {
		if (
			!existsSync("/sys/class/power_supply/BAT0") &&
			!existsSync("/sys/class/power_supply/BAT1")
		)
			return null;
		return "This machine has a battery: if it suspends on lid close it drops off the mesh (see HandleLidSwitch in logind.conf).";
	}
	return null;
}

/** The app's URL as a terminal QR code (uqr). */
export async function terminalQr(url: string): Promise<string> {
	const { renderUnicodeCompact } = await import("uqr");
	return renderUnicodeCompact(url, { border: 2 });
}

export interface MeshDeps {
	tailscale: TailscaleRunner;
	run: CommandRunner;
	fetch: typeof fetch;
	service: ServiceEnv;
	port?: number;
	log: (line: string) => void;
	/**
	 * Shows a fix and waits for Enter to check again. Resolves false when
	 * there is no terminal to wait in (`--yes`, CI) or the user gives up.
	 */
	waitEnter: (prompt: string) => Promise<boolean>;
	/** Turns the app on for this node (the `remote` setting). */
	enableRemote: () => void;
	/** Folder for the node certificate (default `<state>/tls`). */
	certDir?: string;
	/** The operator's own certificate (`--cert/--key/--ca` or the setting): used instead of `tailscale cert`. */
	tls?: TlsFiles | null;
	/** Keeps the operator's certificate in the settings once it checks out. */
	saveTls?: (tls: TlsFiles) => void;
	/** `--rp-id`: checked against this node's name, then kept with `saveRpId`. */
	rpId?: string;
	saveRpId?: (rpId: string) => void;
	/** The clock for certificate checks (tests). */
	now?: number;
	/** How many times to ask the app's `/hello` after the service starts (default 20, 0.5 s apart). */
	appWaitTries?: number;
}

export interface MeshResult {
	ok: boolean;
	url?: string;
	service?: InstallResult;
}

/**
 * `pulsar mesh on`: Tailscale installed, running and signed in; MagicDNS
 * on (re-checked on Enter after each fix); the node certificate: the
 * operator's own (checked), else from `tailscale cert` with HTTPS
 * certificates on (tailscale.com only; a self-hosted control server needs
 * the operator's own); the app turned on; the always-on service installed;
 * the pool listed; the app URL and a QR code printed.
 */
/**
 * Checks the operator's certificate for `dnsName` and trusts its root for
 * this process's probes. False (with the reasons logged) when it can't be used.
 */
export function certOk(
	own: TlsFiles,
	dnsName: string,
	out: {
		ok: (m: string) => void;
		bad: (m: string) => void;
		warn: (m: string) => void;
	},
	now?: number,
): boolean {
	const report = inspectCert(own, dnsName, now === undefined ? {} : { now });
	for (const n of report.notes) out.warn(n);
	for (const p of report.problems) out.bad(p);
	if (report.untrusted) out.bad(report.untrusted);
	if (!report.ok || report.untrusted) return false;
	if (own.ca && !trustCa(own.ca))
		out.warn(
			`this Node cannot add a CA at runtime: set NODE_EXTRA_CA_CERTS=${own.ca} for Pulsar`,
		);
	out.ok(
		`your certificate for ${dnsName} (issued by ${report.issuer}, valid for ${report.days} days)`,
	);
	return true;
}

/**
 * What doctor says about the RP id: a problem when the `rpId` setting is
 * invalid (the app won't start), a note when passkeys can only be per
 * machine (the suffix can't be an RP id), else nothing.
 */
export function rpIdCheck(
	dnsName: string,
	override?: string,
): { bad: string } | { note: string } | null {
	let rp: string;
	try {
		rp = tailnetRpId(dnsName, override);
	} catch (e) {
		return {
			bad: `${(e as Error).message}: fix rpId in settings.json or run \`pulsar mesh on --rp-id <domain>\``,
		};
	}
	return rp === dnsName.toLowerCase().replace(/\.$/, "") && !override
		? {
				note: `passkey RP id is this machine's own name (${rp}): the MagicDNS suffix is a public suffix or one label, so a passkey works only on the machine that made it`,
			}
		: null;
}

export async function runMeshSetup(deps: MeshDeps): Promise<MeshResult> {
	const { log } = deps;
	const port = deps.port ?? DEFAULT_PORT;
	const platform = deps.service.platform;
	const ok = (m: string) => log(`  ✓ ${m}`);
	const bad = (m: string) => log(`  ✗ ${m}`);
	const warn = (m: string) => log(`  ! ${m}`);

	// 1. Tailscale installed, running, signed in, MagicDNS on.
	let ts: TailscaleState;
	for (;;) {
		ts = await readTailscale(deps.tailscale);
		const fix =
			tailscaleFix(ts, platform) ??
			(ts.kind === "running" && !ts.magicDns ? magicDnsFix(ts.control) : null);
		if (!fix) break;
		bad(fix);
		if (!(await deps.waitEnter("Press Enter to check again")))
			return { ok: false };
	}
	if (ts.kind !== "running") return { ok: false };
	if (!ts.self.ownerLogin) {
		bad(
			"This device is a tagged node (no Tailscale user). Run `pulsar mesh on` on a device signed in as you.",
		);
		return { ok: false };
	}
	ok(
		`Tailscale ${ts.version}: ${ts.self.dnsName} signed in as ${ts.self.ownerLogin} (control server: ${controlLabel(ts.control)})`,
	);

	if (deps.rpId) {
		try {
			const rp = tailnetRpId(ts.self.dnsName, deps.rpId);
			deps.saveRpId?.(rp);
			ok(`passkey RP id ${rp}`);
		} catch (e) {
			bad((e as Error).message);
			return { ok: false };
		}
	}

	// 2. The node certificate: the operator's own, else `tailscale cert`.
	const own = deps.tls ?? null;
	if (own) {
		if (!certOk(own, ts.self.dnsName, { ok, bad, warn }, deps.now))
			return { ok: false };
		deps.saveTls?.(own);
	} else if (ts.control.kind === "custom") {
		bad(BRING_CERT_HINT);
		return { ok: false };
	}
	for (; !own; ) {
		if (!ts.self.certDomains.includes(ts.self.dnsName)) {
			bad(`HTTPS certificates are off. ${ENABLE_HTTPS_HINT}`);
		} else {
			try {
				await fetchCert(ts.self.dnsName, {
					run: deps.tailscale,
					...(deps.certDir ? { dir: deps.certDir } : {}),
				});
				ok(`certificate for ${ts.self.dnsName}`);
				break;
			} catch (e) {
				const msg = (e as Error).message;
				if (!certsDisabled(msg) && msg !== ENABLE_HTTPS_HINT) {
					bad(msg);
					return { ok: false };
				}
				bad(`HTTPS certificates are off. ${ENABLE_HTTPS_HINT}`);
			}
		}
		if (!(await deps.waitEnter("Press Enter to check again")))
			return { ok: false };
		const again = await readTailscale(deps.tailscale);
		if (again.kind === "running") ts = again;
	}
	const self = ts.self;

	// 3. The app on, served by the always-on service.
	deps.enableRemote();
	ok(`app on (port ${port})`);
	let service: InstallResult | undefined;
	if (!(await serviceManagerAvailable(deps.service))) {
		// A container or a Linux box without a systemd user session: the
		// rest of setup still applies; the daemon is started by hand.
		warn(
			"no service manager here (no systemd user session): the background service isn't installed. Start the daemon yourself and keep it running, e.g. `tmux new -d -s pulsar 'pulsar daemon --service'`, or with your init system",
		);
	} else {
		try {
			service = await installService(deps.service);
		} catch (e) {
			bad(`background service: ${(e as Error).message}`);
			return { ok: false };
		}
		ok(
			`background service ${service.change} (${service.file.replace(deps.service.home, "~")})`,
		);
		if (service.kind === "systemd") {
			const user = deps.service.env.USER ?? process.env.USER ?? "";
			const linger = await deps.run("loginctl", [
				"show-user",
				user,
				"-p",
				"Linger",
			]);
			if (!/Linger=yes/.test(linger.stdout))
				warn(
					`The service stops when you log out. To keep it running: loginctl enable-linger ${user}`,
				);
		}
		// The service just (re)started: wait a bounded time for the app to answer.
		const wait =
			deps.service.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		let answered: PulsarProbe | null = null;
		for (let i = 0; i < (deps.appWaitTries ?? 20) && !answered; i++) {
			answered = await probePulsar(self.dnsName, port, deps.fetch, 1000);
			if (!answered) await wait(500);
		}
		if (answered) ok(`app answers (Pulsar ${answered.version})`);
		else
			warn(
				`the app does not answer yet; see ${deps.service.stateDir.replace(deps.service.home, "~")}/service.log and run \`pulsar doctor\``,
			);
	}
	const sleepy = await laptopSleepWarning(deps.run, platform);
	if (sleepy) warn(sleepy);

	// 4. The pool.
	const reports = await probePeers(
		ts.peers,
		port,
		deps.fetch,
		undefined,
		ts.suffix,
	);
	if (reports.length === 0)
		log(
			"\nNo other devices signed in as you yet. Run `npx pulsar@2 setup` on each machine that runs agents, and turn the mesh on there.",
		);
	else {
		log("\nYour devices:");
		for (const r of reports) log(`  · ${peerLine(r)}`);
	}

	// 5. The app's URL; `meshOutro` prints it with the QR code last.
	const url = await appUrl({ mode: "tailscale", port }, async () => self);
	if (!url) return { ok: false, service };
	return { ok: true, url, service };
}

/** The end of `pulsar mesh on`: the app's URL, a QR code, and the home-screen hint. */
export async function meshOutro(url: string, log: (line: string) => void) {
	log(`\nOpen the app: ${url}`);
	log(await terminalQr(url));
	log(
		"On your phone: turn Tailscale on, scan this code, then Share → Add to Home Screen.",
	);
}
