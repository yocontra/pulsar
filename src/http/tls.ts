import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as tls from "node:tls";

/**
 * A certificate the operator brings (`pulsar mesh on --cert --key [--ca]`):
 * for a self-hosted control server (Headscale), where `tailscale cert`
 * cannot work, or a company PKI. Pulsar reads the files where they are, so
 * a renewer (step-ca, certbot, a cron job) that replaces them is picked up.
 */
export interface TlsFiles {
	/** PEM: the leaf certificate first, then any intermediates. */
	cert: string;
	/** PEM private key for the leaf. */
	key: string;
	/** PEM root (or roots) that issued it, when not a public CA. */
	ca?: string;
}

const PEM_CERT =
	/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Every certificate in a PEM text, in order. */
export function pemCertificates(text: string): string[] {
	return text.match(PEM_CERT) ?? [];
}

const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
/** Apple refuses TLS server certificates valid longer than this (support.apple.com/103769). */
const APPLE_MAX_DAYS = 825;
const DAY = 86_400_000;

export interface CertReport {
	/** No problem: the app can serve it (see `untrusted` for other nodes). */
	ok: boolean;
	problems: string[];
	notes: string[];
	/** Why Pulsar on other nodes would not trust it (no `ca`, not a public CA). */
	untrusted?: string;
	/** Days until the leaf expires (negative once expired). */
	days?: number;
	/** The leaf's issuer, for messages. */
	issuer?: string;
	/** The chain ends at a root Node's bundled store (a public CA) trusts. */
	publicCa?: boolean;
}

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
	try {
		return child.checkIssued(parent) && child.verify(parent.publicKey);
	} catch {
		return false;
	}
}

function parseAll(pems: string[]): X509Certificate[] {
	const out: X509Certificate[] = [];
	for (const p of pems) {
		try {
			out.push(new X509Certificate(p));
		} catch {}
	}
	return out;
}

function cn(dn: string): string {
	return /(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1] ?? dn.replace(/\n/g, ", ");
}

/**
 * Checks a brought certificate for `dnsName`: files readable, key matches,
 * hostname, validity, chain order, a root that issued it (the `ca` file, a
 * public CA, or NODE_EXTRA_CA_CERTS), server-auth usage, the private key's
 * file mode, and Apple's limits. Read-only.
 */
export function inspectCert(
	files: TlsFiles,
	dnsName: string,
	opts: { now?: number; env?: NodeJS.ProcessEnv } = {},
): CertReport {
	const now = opts.now ?? Date.now();
	const env = opts.env ?? process.env;
	const problems: string[] = [];
	const notes: string[] = [];
	const done = (extra: Partial<CertReport> = {}): CertReport => ({
		ok: problems.length === 0,
		problems,
		notes,
		...extra,
	});
	let chain: X509Certificate[];
	try {
		// sync-ok: setup and doctor (CLI), and a rare reload check
		chain = parseAll(pemCertificates(readFileSync(files.cert, "utf8")));
	} catch (e) {
		problems.push(
			`cannot read certificate ${files.cert}: ${(e as Error).message}`,
		);
		return done();
	}
	const leaf = chain[0];
	if (!leaf) {
		problems.push(`${files.cert} holds no PEM certificate`);
		return done();
	}
	try {
		// sync-ok: as above
		const key = createPrivateKey(readFileSync(files.key));
		if (!leaf.checkPrivateKey(key))
			problems.push(`${files.key} is not the key for ${files.cert}`);
		// sync-ok: as above
		const mode = statSync(files.key).mode;
		// World-readable is refused; group-readable (a renewer's group) is noted.
		if ((mode & 0o007) !== 0)
			problems.push(
				`${files.key} is readable by every user: chmod 600 ${files.key}`,
			);
		else if ((mode & 0o070) !== 0)
			notes.push(
				`${files.key} is readable by its group; chmod 600 if no renewer needs that`,
			);
	} catch (e) {
		problems.push(`cannot read key ${files.key}: ${(e as Error).message}`);
	}
	if (leaf.ca)
		problems.push(
			`${files.cert} starts with a CA certificate; put the server certificate first`,
		);
	if (!leaf.checkHost(dnsName, { subject: "never" }))
		problems.push(
			`the certificate is not for ${dnsName} (it names ${leaf.subjectAltName ?? cn(leaf.subject)})`,
		);
	const from = Date.parse(leaf.validFrom);
	const to = Date.parse(leaf.validTo);
	const days = Math.floor((to - now) / DAY);
	if (now < from)
		problems.push(`the certificate is not valid until ${leaf.validFrom}`);
	if (days < 0) problems.push(`the certificate expired on ${leaf.validTo}`);
	else if (days < 14)
		notes.push(`the certificate expires in ${days} day(s): renew it`);
	if ((to - from) / DAY > APPLE_MAX_DAYS)
		notes.push(
			`the certificate is valid for more than ${APPLE_MAX_DAYS} days; iPhones and Macs refuse that`,
		);
	const eku = leaf.keyUsage;
	if (Array.isArray(eku) && eku.length > 0 && !eku.includes(SERVER_AUTH))
		problems.push(
			"the certificate is not for TLS servers (no serverAuth usage)",
		);
	for (let i = 0; i + 1 < chain.length; i++)
		if (!issuedBy(chain[i]!, chain[i + 1]!)) {
			problems.push(
				`${files.cert}: certificate ${i + 2} did not issue certificate ${i + 1}; order is leaf, then intermediates`,
			);
			break;
		}

	// Which root vouches for the chain's last certificate.
	const last = chain[chain.length - 1]!;
	let caRoots: X509Certificate[] = [];
	if (files.ca) {
		try {
			// sync-ok: as above
			caRoots = parseAll(pemCertificates(readFileSync(files.ca, "utf8")));
			if (caRoots.length === 0)
				problems.push(`${files.ca} holds no PEM certificate`);
		} catch (e) {
			problems.push(`cannot read CA ${files.ca}: ${(e as Error).message}`);
		}
	}
	const vouches = (roots: X509Certificate[]) =>
		roots.some(
			(r) => issuedBy(last, r) || last.fingerprint256 === r.fingerprint256,
		);
	const publicCa = vouches(parseAll([...tls.rootCertificates]));
	let extra: X509Certificate[] = [];
	if (env.NODE_EXTRA_CA_CERTS) {
		try {
			// sync-ok: as above (a small CA file, read once when the cert loads)
			const pem = readFileSync(env.NODE_EXTRA_CA_CERTS, "utf8");
			extra = parseAll(pemCertificates(pem));
		} catch {}
	}
	if (files.ca && caRoots.length > 0 && !vouches(caRoots))
		problems.push(
			`${files.ca} did not issue this certificate (issuer: ${cn(last.issuer)})`,
		);
	const untrusted =
		!files.ca && !publicCa && !vouches(extra)
			? `the certificate is from ${cn(last.issuer)}, not a public CA: pass its root with --ca (on every machine) so Pulsar trusts the other machines' certificates`
			: undefined;
	return done({
		days,
		issuer: cn(leaf.issuer),
		publicCa,
		...(untrusted ? { untrusted } : {}),
	});
}

/**
 * Makes this process trust `ca` (PEM roots) for outgoing TLS (federation
 * requests, setup's and doctor's probes), on top of the public CAs. False
 * when this Node has no `tls.setDefaultCACertificates` (older releases):
 * then NODE_EXTRA_CA_CERTS must name the root.
 */
export function trustCa(caFile: string): boolean {
	const t = tls as typeof tls & {
		setDefaultCACertificates?: (certs: string[]) => void;
		getCACertificates?: (kind: string) => string[];
	};
	if (!t.setDefaultCACertificates || !t.getCACertificates) return false;
	// sync-ok: once at startup
	const extra = pemCertificates(readFileSync(caFile, "utf8"));
	t.setDefaultCACertificates([...t.getCACertificates("default"), ...extra]);
	return true;
}

/**
 * Calls `onChange` when the certificate or key file changes (polled: a
 * renewer usually replaces the file by renaming, which a file watch loses).
 */
export function watchTlsFiles(
	files: Pick<TlsFiles, "cert" | "key">,
	onChange: () => void,
	intervalMs = 60_000,
): () => void {
	const sig = async () => {
		const s = await Promise.all(
			[files.cert, files.key].map((f) =>
				stat(f).then(
					(x) => `${x.ino}:${x.size}:${x.mtimeMs}`,
					() => "missing",
				),
			),
		);
		return s.join("|");
	};
	let last: Promise<string> = sig();
	const timer = setInterval(() => {
		void (async () => {
			const before = await last;
			const p = sig();
			last = p;
			if ((await p) !== before) onChange();
		})();
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
