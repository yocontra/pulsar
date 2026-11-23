import { join } from "node:path";
import {
	magicDnsSuffix,
	type Tailnet,
	tailnetRpId,
} from "../federation/tailnet.ts";
import { daemonLog } from "../log.ts";
import { stateDir } from "../paths.ts";
import type { PulsarService } from "../service/index.ts";
import { HttpTransport } from "../transport/http.ts";
import { type RemoteConfig, readSettingsAsync, tlsSetting } from "./config.ts";
import { readControlPlane } from "./control.ts";
import {
	BRING_CERT_HINT,
	ENABLE_HTTPS_HINT,
	fetchCert,
	localApiRunner,
	runTailscale,
	StaticIdentity,
	TailscaleIdentity,
	tailscaleSelfOrWhy,
} from "./identity.ts";
import { inspectCert, trustCa, watchTlsFiles } from "./tls.ts";

const RENEW_MS = 24 * 3600_000;

/**
 * Starts the app's HTTP transport for a daemon. Dev mode: plain HTTP on
 * 127.0.0.1, every connection is the dev login. Tailscale mode (also on a
 * self-hosted control server such as Headscale): TLS on this node's
 * Tailscale addresses, the owner from `tailscale status`, identity from
 * `tailscale whois`. The certificate is the operator's own (the `tls`
 * setting; reloaded when its files change) or else one from `tailscale
 * cert`, renewed daily. Throws (for the caller to log) when Tailscale is
 * missing, the node has no owner (a tagged node), or there is no usable
 * certificate.
 */
/**
 * Tailscale is not up yet (not running, logged out, its CLI unreachable):
 * the daemon keeps retrying, and doctor says it is waiting for Tailscale.
 */
export class TailscaleNotReady extends Error {}

/** The app's HTTP transport, as `startRemote` returns it. */
export interface RemoteApp {
	transport: HttpTransport;
	/** The addresses it listens on (Tailscale's, or 127.0.0.1 in dev mode). */
	hosts: string[];
	close: () => Promise<void>;
}

export interface RemoteOptions {
	/**
	 * Tailscale now reports other addresses for this node than the ones the
	 * app listens on (seen on the pool's status polls). The daemon listens again.
	 */
	onAddressesChanged?: (ips: string[]) => void;
}

export async function startRemote(
	service: PulsarService,
	cfg: Exclude<RemoteConfig, { mode: "off" }>,
	opts: RemoteOptions = {},
): Promise<RemoteApp> {
	if (cfg.mode === "dev") {
		const transport = new HttpTransport(service, {
			identity: new StaticIdentity(cfg.login, "localhost"),
			owner: cfg.login,
			hosts: ["127.0.0.1"],
			port: cfg.port,
		});
		await transport.listen();
		daemonLog(`app (dev, ${cfg.login}) at ${transport.url}`);
		return {
			transport,
			hosts: ["127.0.0.1"],
			close: () => transport.close(),
		};
	}
	// A busy machine can take seconds to answer; a short timeout here reads as
	// "Tailscale is off" and the app stays down until the next retry.
	const { self, why } = await tailscaleSelfOrWhy((args) =>
		runTailscale(args, 15_000),
	);
	if (!self)
		throw new TailscaleNotReady(
			`Tailscale is not running or not logged in (${why})`,
		);
	// A tagged node has no user of its own: the pool owner comes from
	// `pulsar mesh owner <login>` (kept in the store).
	const userOwner =
		self.ownerLogin && self.ownerLogin !== "tagged-devices"
			? self.ownerLogin
			: null;
	const owner = userOwner ?? service.poolMembers.owner ?? null;
	if (!owner)
		throw new Error(
			"this node has no Tailscale user (a tagged node): name the pool owner with `pulsar mesh owner <login>`",
		);
	if (self.ips.length === 0)
		throw new Error("this node has no Tailscale address");
	const settings = await readSettingsAsync();
	const own = tlsSetting(settings);
	let tls: { cert: string; key: string };
	if (own) {
		if (own.ca && !trustCa(own.ca))
			daemonLog(
				`this Node cannot add a CA at runtime: set NODE_EXTRA_CA_CERTS=${own.ca} for the service`,
			);
		const report = inspectCert(own, self.dnsName);
		if (!report.ok)
			throw new Error(`certificate ${own.cert}: ${report.problems.join("; ")}`);
		if (report.untrusted) daemonLog(`certificate: ${report.untrusted}`);
		tls = { cert: own.cert, key: own.key };
	} else {
		if (!self.certDomains.includes(self.dnsName)) {
			const control = await readControlPlane(
				runTailscale,
				magicDnsSuffix(self.dnsName),
			);
			throw new Error(
				control.kind === "custom" ? BRING_CERT_HINT : ENABLE_HTTPS_HINT,
			);
		}
		tls = await fetchCert(self.dnsName);
	}
	const rpId = tailnetRpId(self.dnsName, settings.rpId);
	// The owner's user id, when this node is the owner's own: logins can
	// repeat on a self-hosted control server, ids cannot.
	const ownerId = userOwner === owner ? self.ownerId : null;
	const transport = new HttpTransport(service, {
		// whois over tailscaled's LocalAPI (the CLI as the fallback), and known
		// addresses kept across restarts: a deploy's first request no longer
		// waits seconds for a whois on a loaded machine.
		identity: new TailscaleIdentity({
			run: localApiRunner(),
			file: join(stateDir(), "identity-cache.json"),
		}),
		owner,
		...(ownerId ? { ownerId } : {}),
		hosts: self.ips,
		port: cfg.port,
		tls,
		publicName: self.dnsName,
		rpId,
	});
	transport.onWarn = (line) => daemonLog(`app: ${line}`);
	await transport.listen();
	daemonLog(`app at ${transport.url} for ${owner}`);
	// The pool: every other pulsar node of this user.
	const { Federation } = await import("../federation/index.ts");
	const { TailscaleTailnet } = await import("../federation/tailnet.ts");
	// The pool polls `tailscale status`; the same poll tells when this node's
	// addresses change (a new tailnet, a re-login), so the app listens again.
	const tailnet = watchAddresses(
		new TailscaleTailnet(transport.port),
		self.ips,
		(ips) => opts.onAddressesChanged?.(ips),
	);
	const fed = new Federation(service, {
		tailnet,
		owner,
		...(ownerId ? { ownerId } : {}),
		port: transport.port,
		rpId,
		log: (line) => daemonLog(`pool: ${line}`),
	});
	transport.fed = fed;
	void fed
		.start()
		.catch((e) => daemonLog(`pool not started: ${(e as Error).message}`));
	let stopRenew: () => void;
	if (own) {
		// The operator's renewer replaces the files; a bad one is never loaded.
		stopRenew = watchTlsFiles(own, () => {
			const report = inspectCert(own, self.dnsName);
			if (!report.ok) {
				daemonLog(`new certificate not loaded: ${report.problems.join("; ")}`);
				return;
			}
			transport
				.reloadTls()
				.then(() =>
					daemonLog(`certificate reloaded (${report.days} days left)`),
				)
				.catch((e) =>
					daemonLog(`certificate reload failed: ${(e as Error).message}`),
				);
		});
	} else {
		const renew = setInterval(() => {
			fetchCert(self.dnsName)
				.then(() => transport.reloadTls())
				.catch((e) =>
					daemonLog(`certificate renewal failed: ${(e as Error).message}`),
				);
		}, RENEW_MS);
		renew.unref();
		stopRenew = () => clearInterval(renew);
	}
	return {
		transport,
		hosts: self.ips,
		close: async () => {
			stopRenew();
			fed.stop();
			await transport.close();
		},
	};
}

/**
 * `tailnet`, whose status calls also report (`onChange`) when this node's
 * addresses are no longer `served`.
 */
export function watchAddresses<T extends Tailnet>(
	tailnet: T,
	served: string[],
	onChange: (ips: string[]) => void,
): T {
	const status = tailnet.status.bind(tailnet);
	tailnet.status = async () => {
		const st = await status();
		const ips = st?.self.ips;
		if (ips?.length && !sameAddresses(ips, served)) onChange(ips);
		return st;
	};
	return tailnet;
}

/** The same set of addresses, in any order. */
export function sameAddresses(a: string[], b: string[]): boolean {
	const set = new Set(a);
	return set.size === new Set(b).size && b.every((x) => set.has(x));
}
