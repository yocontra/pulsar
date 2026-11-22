import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { controlLabel } from "../http/control.ts";
import {
	BRING_CERT_HINT,
	isTailscaleAddr,
	normalizeAddr,
	type TailscaleRunner,
	tailscaleCertPaths,
} from "../http/identity.ts";
import { inspectCert, type TlsFiles } from "../http/tls.ts";
import type { PoolMachine } from "../service/pool.ts";
import {
	ADMIN_DNS_URL,
	certOk,
	magicDnsFix,
	peerLine,
	probePeers,
	readTailscale,
	rpIdCheck,
	tailscaleFix,
} from "./mesh.ts";
import {
	type CommandRunner,
	type ServiceEnv,
	serviceCli,
	serviceStatus,
} from "./service.ts";

export interface MeshDoctorDeps {
	tailscale: TailscaleRunner;
	run: CommandRunner;
	fetch: typeof fetch;
	service: ServiceEnv;
	/** The app is on (`pulsar mesh on`): mesh problems count as failures. */
	remoteOn: boolean;
	port: number;
	certDir?: string;
	now?: number;
	/** The running daemon's pool (its federation's links), when it runs. */
	pool?: () => Promise<PoolMachine[] | null>;
	/** Tagged nodes `pulsar mesh allow` let in. */
	allowed?: string[];
	/** The operator's own certificate (the `tls` setting), when set. */
	tls?: TlsFiles | null;
	/** The `rpId` setting, when set. */
	rpId?: string;
}

/** Where checks go; `fix` is what to do about a problem (src/diagnostics/checks.ts). */
export interface Report {
	ok: (msg: string) => void;
	bad: (msg: string, fix?: string) => void;
	note: (msg: string, fix?: string) => void;
}

/** What the mesh checks read, besides the checks (the app's machine facts). */
export interface MeshFacts {
	tailscale: {
		state: string;
		version: string | null;
		dnsName: string | null;
		magicDns: boolean | null;
	};
	/** Days until the node certificate (Tailscale's or the operator's own) expires. */
	certDays: number | null;
}

/**
 * The addresses something listens on for `port`, from `lsof -F n`
 * (`n100.1.2.3:7337`, `n[fd7a::1]:7337`, `n*:7337`).
 */
export function parseLsofListen(out: string): string[] {
	const addrs = new Set<string>();
	for (const line of out.split("\n")) {
		if (!line.startsWith("n")) continue;
		const name = line.slice(1).trim();
		const colon = name.lastIndexOf(":");
		if (colon <= 0) continue;
		addrs.add(name.slice(0, colon).replace(/^\[|\]$/g, ""));
	}
	return [...addrs];
}

async function listening(
	run: CommandRunner,
	port: number,
): Promise<string[] | null> {
	const args = ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"];
	for (const bin of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
		const r = await run(bin, args);
		if (r.missing) continue;
		// lsof exits 1 when nothing matches.
		return parseLsofListen(r.stdout);
	}
	return null;
}

/** The `tailscale cert` file pulsar keeps: present, valid, key private. */
function tailscaleCertCheck(
	dnsName: string,
	deps: Pick<MeshDoctorDeps, "certDir">,
	{ ok, bad, note }: Report,
	now: number,
): number | null {
	const paths = tailscaleCertPaths(dnsName, deps.certDir);
	if (!existsSync(paths.cert) || !existsSync(paths.key)) {
		bad("no node certificate yet", "run `pulsar mesh on`");
		return null;
	}
	try {
		const cert = new X509Certificate(readFileSync(paths.cert));
		const days = Math.floor((Date.parse(cert.validTo) - now) / 86_400_000);
		if (days < 0)
			bad(
				"node certificate expired",
				"restart the service, or run `pulsar mesh on`",
			);
		else if (days < 14)
			note(
				`node certificate expires in ${days} day(s); the daemon renews it daily`,
			);
		else ok(`node certificate valid for ${days} days`);
		if ((statSync(paths.key).mode & 0o077) !== 0)
			bad(
				`certificate key ${paths.key} is readable by others`,
				`chmod 600 ${paths.key}`,
			);
		return days;
	} catch (e) {
		bad(`node certificate unreadable: ${(e as Error).message}`);
		return null;
	}
}

/**
 * `pulsar doctor`'s mesh checks: Tailscale, MagicDNS, HTTPS certificates, the
 * node certificate, the app setting, the background service, what listens on
 * the app port, and the other devices. Read-only: never fetches a
 * certificate or starts anything.
 */
export async function meshChecks(
	deps: MeshDoctorDeps,
	out: Report,
): Promise<MeshFacts> {
	const { ok, note } = out;
	const bad = deps.remoteOn ? out.bad : note;
	const env = deps.service;
	const now = deps.now ?? Date.now();

	const ts = await readTailscale(deps.tailscale);
	const facts: MeshFacts = {
		tailscale: {
			state: ts.kind,
			version: ts.kind === "running" ? ts.version : null,
			dnsName: ts.kind === "running" ? ts.self.dnsName : null,
			magicDns: ts.kind === "running" ? ts.magicDns : null,
		},
		certDays: null,
	};
	const fix = tailscaleFix(ts, env.platform);
	if (fix) bad(fix);
	if (ts.kind === "running") {
		ok(
			`Tailscale ${ts.version}: ${ts.self.dnsName}${ts.self.ownerLogin ? ` (${ts.self.ownerLogin})` : ""}, control server ${controlLabel(ts.control)}`,
		);
		if (!ts.self.ownerLogin)
			bad(
				"this device is a tagged node (no Tailscale user); the app needs a device signed in as you",
			);
		if (ts.magicDns) ok("MagicDNS on");
		else bad(magicDnsFix(ts.control));
		const rp = rpIdCheck(ts.self.dnsName, deps.rpId);
		if (rp && "bad" in rp) bad(rp.bad);
		else if (rp) note(rp.note);
		if (deps.tls) {
			// The operator's own certificate (a self-hosted control server, or a company PKI).
			certOk(deps.tls, ts.self.dnsName, { ok, bad, warn: note }, now);
			facts.certDays =
				inspectCert(deps.tls, ts.self.dnsName, { now }).days ?? null;
		} else if (ts.control.kind === "custom") {
			bad(BRING_CERT_HINT);
		} else {
			if (ts.self.certDomains.includes(ts.self.dnsName))
				ok("HTTPS certificates on");
			else
				bad("HTTPS certificates are off", `turn them on at ${ADMIN_DNS_URL}`);
			facts.certDays = tailscaleCertCheck(
				ts.self.dnsName,
				deps,
				{ ok, bad, note },
				now,
			);
		}
	}

	if (deps.remoteOn) ok(`app on (port ${deps.port})`);
	else note("app off on this device", "run `pulsar mesh on` to join the mesh");

	const svc = await serviceStatus(env);
	if (!svc) bad("background service not installed", "run `pulsar mesh on`");
	else {
		const where = svc.file.replace(env.home, "~");
		if (!svc.fileExists)
			bad(
				`background service file ${where} is missing`,
				"run `pulsar mesh on`",
			);
		else if (!svc.loaded)
			bad(`background service not loaded (${where})`, "run `pulsar mesh on`");
		else if (!svc.running)
			bad(
				"background service loaded but not running",
				`see ${env.stateDir.replace(env.home, "~")}/service.log`,
			);
		else ok(`background service running (pid ${svc.pid ?? "?"})`);
		// Runtime flags (V8 options) may sit between node and the CLI.
		const [node, ...rest] = svc.args;
		const cli = rest.find((a) => !a.startsWith("-"));
		if (!node || !existsSync(node))
			bad(
				`service node binary ${node ?? "(none)"} is missing`,
				"run `pulsar mesh on` again",
			);
		if (cli !== serviceCli(env))
			bad(
				`service runs ${cli ?? "(none)"}, not the current install`,
				"run `pulsar mesh on`",
			);
		else if (!existsSync(cli))
			bad(`service CLI ${cli} is missing`, "run `pulsar mesh on`");
	}

	const addrs = await listening(deps.run, deps.port);
	if (addrs === null) note("could not check listeners (no lsof)");
	else if (addrs.length === 0) {
		if (deps.remoteOn) out.bad(`nothing listens on port ${deps.port}`);
		else note(`nothing listens on port ${deps.port}`);
	} else {
		const outside = addrs.filter((a) => !isTailscaleAddr(normalizeAddr(a)));
		if (outside.length)
			out.bad(
				`port ${deps.port} listens outside Tailscale: ${outside.join(", ")}`,
			);
		else
			ok(
				`HTTPS on Tailscale addresses only (${addrs.join(", ")}:${deps.port})`,
			);
	}

	if (ts.kind === "running") {
		const reports = await probePeers(
			ts.peers,
			deps.port,
			deps.fetch,
			deps.allowed,
			ts.suffix,
		);
		if (reports.length === 0) note("no other devices signed in as you");
		const pool = (await deps.pool?.().catch(() => null)) ?? [];
		const allowed = new Set(deps.allowed ?? []);
		for (const r of reports) {
			const link = pool.find(
				(m) => m.name === (r.pulsar?.machine ?? r.peer.name),
			);
			const line = peerLine(r, link, allowed.has(r.peer.name));
			if (r.pulsar && (!link || link.link === "tailnet")) ok(line);
			else note(line);
		}
	}
	return facts;
}
