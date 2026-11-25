import { afterEach, describe, expect, test } from "bun:test";
import {
	createDecipheriv,
	createECDH,
	createHmac,
	createPublicKey,
	verify,
} from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushPayload } from "../src/http/wire.ts";
import {
	allowedEndpoint,
	encryptPayload,
	generateVapidKeys,
	vapidAuthorization,
} from "../src/push/webpush.ts";
import type { RpcError } from "../src/rpc.ts";
import type { Caller, Principal } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { until } from "./helpers.ts";

const b = (s: string) => Buffer.from(s, "base64url");

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number) {
	const prk = createHmac("sha256", salt).update(ikm).digest();
	return createHmac("sha256", prk)
		.update(Buffer.concat([info, Buffer.from([1])]))
		.digest()
		.subarray(0, len);
}

/** The browser's side of RFC 8291: decrypts one aes128gcm record. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
	const salt = body.subarray(0, 16);
	const idlen = body[20]!;
	const asPublic = body.subarray(21, 21 + idlen);
	const ct = body.subarray(21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const uaPublic = ecdh.getPublicKey();
	const secret = ecdh.computeSecret(asPublic);
	const ikm = hkdf(
		auth,
		secret,
		Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
		32,
	);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const d = createDecipheriv("aes-128-gcm", cek, nonce);
	d.setAuthTag(ct.subarray(ct.length - 16));
	const plain = Buffer.concat([
		d.update(ct.subarray(0, ct.length - 16)),
		d.final(),
	]);
	expect(plain[plain.length - 1]).toBe(2);
	return plain.subarray(0, plain.length - 1);
}

function browser() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = Buffer.from("0123456789abcdef");
	return {
		priv: ecdh.getPrivateKey(),
		auth,
		keys: {
			p256dh: ecdh.getPublicKey().toString("base64url"),
			auth: auth.toString("base64url"),
		},
	};
}

describe("Web Push crypto", () => {
	test("matches the RFC 8291 test vector", () => {
		const body = encryptPayload(
			{
				endpoint: "https://push.example.net/x",
				keys: {
					p256dh:
						"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
					auth: "BTBZMqHH6r4Tts7J_aSIgg",
				},
			},
			b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
			{
				salt: b("DGv6ra1nlYgDCS1FRnbzlw"),
				asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
			},
		);
		expect(body.toString("base64url")).toBe(
			"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
		);
	});

	test("a browser decrypts what pulsar encrypts", () => {
		const ua = browser();
		const body = encryptPayload(
			{ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: ua.keys },
			Buffer.from('{"kind":"approval"}'),
		);
		expect(decrypt(body, ua.priv, ua.auth).toString()).toBe(
			'{"kind":"approval"}',
		);
	});

	test("the VAPID header is an ES256 JWT for the push service's origin", () => {
		const keys = generateVapidKeys();
		const h = vapidAuthorization(
			keys,
			"https://web.push.apple.com/abc?x=1",
			"https://github.com/yocontra/pulsar",
			1_700_000_000_000,
		);
		const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
		expect(m[4]).toBe(keys.publicKey);
		const claims = JSON.parse(b(m[2]!).toString());
		expect(claims).toEqual({
			aud: "https://web.push.apple.com",
			exp: 1_700_000_000 + 12 * 3600,
			sub: "https://github.com/yocontra/pulsar",
		});
		const pub = b(keys.publicKey);
		const key = createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: pub.subarray(1, 33).toString("base64url"),
				y: pub.subarray(33).toString("base64url"),
			},
			format: "jwk",
		});
		expect(
			verify(
				"sha256",
				Buffer.from(`${m[1]}.${m[2]}`),
				{ key, dsaEncoding: "ieee-p1363" },
				b(m[3]!),
			),
		).toBe(true);
	});

	test("only known push services are allowed", () => {
		for (const ok of [
			"https://web.push.apple.com/QO",
			"https://fcm.googleapis.com/fcm/send/abc",
			"https://updates.push.services.mozilla.com/wpush/v2/x",
			"https://wns2-par02p.notify.windows.com/w/?token=x",
		])
			expect(allowedEndpoint(ok)).toBe(true);
		for (const bad of [
			"http://web.push.apple.com/x",
			"https://web.push.apple.com:8443/x",
			"https://evil.example/push.apple.com",
			"https://localhost/x",
			"https://169.254.169.254/latest",
			"not a url",
		])
			expect(allowedEndpoint(bad)).toBe(false);
	});
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("push service", () => {
	const user: Principal = { kind: "human", login: "me@x", node: "phone" };

	function setup(status = 201) {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-push-"));
		const sent: {
			url: string;
			headers: Record<string, string>;
			body: Uint8Array;
		}[] = [];
		const store = new Store(":memory:");
		const service = new PulsarService({
			store,
			scan: false,
			machine: "studio",
			approvals: { probe: () => null, answerable: () => true },
			push: {
				keyFile: join(dir, "vapid.json"),
				send: async (url, init) => {
					sent.push({ url, headers: init.headers, body: init.body });
					return { status };
				},
			},
		});
		service.push.start();
		cleanups.push(() => {
			service.stop();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		return { service, sent, dir };
	}

	test("a new approval pushes its text encrypted, with an opaque topic; the key file is 0600", async () => {
		const { service, sent, dir } = setup();
		const ua = browser();
		const key = await service.push.publicKey(user);
		expect(b(key).length).toBe(65);
		expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
		service.push.subscribe(user, {
			endpoint: "https://web.push.apple.com/sub1",
			keys: ua.keys,
		});
		const agent = service.registry.upsert({
			harness: "claude",
			sessionId: "s1",
			pid: null,
			cwd: "/secret/project",
			project: "secret",
			branch: "main",
			tags: [],
			meta: {},
			registered: true,
		});
		const ac = new AbortController();
		const caller: Caller = {
			principal: { kind: "agent", agentId: agent.id },
			closed: ac.signal,
			emit() {},
		};
		void service.approvals.request(caller, {
			sessionId: "s1",
			promptId: "p",
			tool: "Bash",
			input: { command: "cat ~/.ssh/id_rsa" },
			suggestions: [],
			cwd: "/secret/project",
			transcriptPath: null,
		});
		const id = service.approvals.pendingFor(agent.id)[0]!.requestId;
		await new Promise((r) => setTimeout(r, 20));
		// One push for "notifications turned on" (security), one for the approval.
		expect(sent).toHaveLength(2);
		sent.shift();
		expect(sent[0]!.headers["Content-Encoding"]).toBe("aes128gcm");
		expect(sent[0]!.headers.Urgency).toBe("high");
		const payload = JSON.parse(
			decrypt(Buffer.from(sent[0]!.body), ua.priv, ua.auth).toString(),
		) as PushPayload;
		expect(payload).toMatchObject({
			kind: "approval",
			id,
			badge: 1,
			title: `${agent.name} needs approval`,
			body: "Run cat ~/.ssh/id_rsa?",
			url: `/#/approval/${encodeURIComponent(agent.id)}`,
		});
		// The tag and topic carry the agent's opaque token, never a name.
		expect(payload.tag).toMatch(/^agent:[A-Za-z0-9_-]{22}$/);
		expect(sent[0]!.headers.Topic).toBe(payload.tag!.slice("agent:".length));
		// The ciphertext holds no plaintext.
		expect(Buffer.from(sent[0]!.body).toString("latin1")).not.toContain(
			"id_rsa",
		);
		ac.abort();
	});

	test("a finish while a prompt still waits gets its own tag and topic", async () => {
		const { service, sent } = setup();
		const ua = browser();
		const endpoint = "https://web.push.apple.com/both";
		service.push.subscribe(user, { endpoint, keys: ua.keys });
		service.push.settings(user, { endpoint, turns: "notify" });
		const agent = service.registry.upsert({
			harness: "claude",
			sessionId: "s2",
			pid: null,
			cwd: "/w/webshop",
			project: "webshop",
			branch: null,
			tags: [],
			meta: {},
			registered: true,
		});
		const ac = new AbortController();
		const caller: Caller = {
			principal: { kind: "agent", agentId: agent.id },
			closed: ac.signal,
			emit() {},
		};
		void service.approvals.request(caller, {
			sessionId: "s2",
			promptId: "p",
			tool: "Bash",
			input: { command: "bun test" },
			suggestions: [],
			cwd: "/w/webshop",
			transcriptPath: null,
		});
		await until(() => sent.length >= 2);
		const read = (i: number) =>
			JSON.parse(
				decrypt(Buffer.from(sent[i]!.body), ua.priv, ua.auth).toString(),
			) as PushPayload;
		const prompt = read(1);
		expect(prompt.tag).toMatch(/^agent:/);
		service.events.emit("notify", {
			kind: "finished",
			agentId: agent.id,
			at: Date.now(),
		});
		await until(() => sent.length >= 3);
		const done = read(2);
		const ref = prompt.tag!.slice("agent:".length);
		expect(done.tag).toBe(`turn:${ref}`);
		expect(sent[2]!.headers.Topic).toBe(`t${ref}`);
		expect(sent[1]!.headers.Topic).toBe(ref);
		ac.abort();
	});

	test("a gone subscription (410) is dropped; unknown push hosts are refused", async () => {
		const { service } = setup(410);
		service.push.subscribe(user, {
			endpoint: "https://fcm.googleapis.com/fcm/send/x",
			keys: browser().keys,
		});
		expect(service.push.count()).toBe(1);
		await service.push.notify({ kind: "approval", id: "x", badge: 0 });
		expect(service.push.count()).toBe(0);
		let code = "";
		try {
			service.push.subscribe(user, {
				endpoint: "https://internal.example/hook",
				keys: browser().keys,
			});
		} catch (e) {
			code = (e as RpcError).code;
		}
		expect(code).toBe("bad_request");
		let agentCode = "";
		try {
			await service.push.publicKey({ kind: "agent", agentId: "a" });
		} catch (e) {
			agentCode = (e as RpcError).code;
		}
		expect(agentCode).toBe("forbidden");
	});

	test("an outage or an overloaded push service never deletes a subscription; repeated refusals do", async () => {
		for (const status of [503, 429]) {
			const { service } = setup(status);
			service.push.subscribe(user, {
				endpoint: "https://web.push.apple.com/flaky",
				keys: browser().keys,
			});
			for (let i = 0; i < 25; i++)
				await service.push.notify({ kind: "approval", id: `x${i}`, badge: 0 });
			expect(service.push.count()).toBe(1);
		}
		const { service } = setup(403);
		service.push.subscribe(user, {
			endpoint: "https://web.push.apple.com/refused",
			keys: browser().keys,
		});
		for (let i = 0; i < 25; i++)
			await service.push.notify({ kind: "approval", id: `x${i}`, badge: 0 });
		expect(service.push.count()).toBe(0);
	});

	test("a flood of subscriptions never evicts the user's (#16); new ones are announced", async () => {
		const { service } = setup();
		const notices: string[] = [];
		service.events.on("security", (n) => notices.push(n.message));
		const mine = "https://web.push.apple.com/the-users-phone";
		service.push.subscribe(user, { endpoint: mine, keys: browser().keys });
		let refused = 0;
		for (let i = 0; i < 60; i++) {
			try {
				service.push.subscribe(user, {
					endpoint: `https://fcm.googleapis.com/fcm/send/bogus${i}`,
					keys: browser().keys,
				});
			} catch (e) {
				expect((e as RpcError).code).toBe("rate_limited");
				refused++;
			}
		}
		expect(refused).toBe(11);
		const rows = service.store.db
			.prepare("SELECT endpoint FROM push_subscriptions WHERE endpoint = ?")
			.all(mine);
		expect(rows).toHaveLength(1);
		expect(
			notices.filter((n) => n.startsWith("Notifications turned on")),
		).toHaveLength(50);
	});

	test("security notices push at most once a minute, saying what changed", async () => {
		const { service, sent } = setup();
		const ua = browser();
		service.push.subscribe(user, {
			endpoint: "https://web.push.apple.com/sec",
			keys: ua.keys,
		});
		// Subscribing is itself announced (one push); five more notices within the minute add none.
		for (let i = 0; i < 5; i++)
			service.events.emit("security", {
				kind: "enrollment",
				message: "Passkey enrollment started on studio (/dev/ttys009)",
				node: "studio",
				at: Date.now(),
			});
		await until(() => sent.length >= 1);
		await new Promise((r) => setTimeout(r, 50));
		expect(sent).toHaveLength(1);
		const payload = JSON.parse(
			decrypt(Buffer.from(sent[0]!.body), ua.priv, ua.auth).toString(),
		);
		expect(payload).toMatchObject({
			kind: "security",
			badge: 0,
			title: "Notifications turned on",
			tag: "security",
			url: "/",
		});
		expect(payload.body).toContain("Not you? Check Settings.");
	});

	test("previews off: generic copy with no names or commands, same tag and link", async () => {
		const { service, sent } = setup();
		const ua = browser();
		const endpoint = "https://web.push.apple.com/quiet";
		service.push.subscribe(user, { endpoint, keys: ua.keys });
		expect(
			service.push.settings(user, { endpoint, previews: false }).previews,
		).toBe(false);
		await until(() => sent.length >= 1);
		const first = JSON.parse(
			decrypt(Buffer.from(sent[0]!.body), ua.priv, ua.auth).toString(),
		);
		expect(first.title).toBe("Notifications turned on");
		sent.length = 0;
		service.events.emit("approval", {
			approval: {
				requestId: "r1",
				agentId: "claude:quiet",
				machine: "studio",
				tool: "Bash",
				input: { command: "deploy --prod" },
				inputHash: "0",
				cwd: null,
				branch: null,
				createdAt: 0,
				expiresAt: 0,
				state: "pending",
				sessionRules: null,
			},
		});
		await until(() => sent.length >= 1);
		const body = decrypt(
			Buffer.from(sent[0]!.body),
			ua.priv,
			ua.auth,
		).toString();
		expect(JSON.parse(body)).toMatchObject({
			kind: "approval",
			id: "r1",
			title: "Approval needed",
			body: "An agent is waiting for your approval.",
			url: "/#/approval/claude%3Aquiet",
		});
		expect(body).not.toContain("deploy");
	});

	test("a usage limit warning names the plan and window, on its own topic", async () => {
		const { service, sent } = setup();
		const ua = browser();
		service.push.subscribe(user, {
			endpoint: "https://web.push.apple.com/lim",
			keys: ua.keys,
		});
		await until(() => sent.length >= 1);
		sent.shift();
		const warn = {
			harness: "codex",
			label: "Weekly",
			usedPercent: 96,
			resetsAt: Date.now() + 3_600_000,
		};
		service.events.emit("limit", { ...warn, level: 95, reached: false });
		service.events.emit("limit", { ...warn, level: 100, reached: true });
		await until(() => sent.length >= 2);
		const bodies = sent.map((x) =>
			decrypt(Buffer.from(x.body), ua.priv, ua.auth).toString(),
		);
		expect(bodies.map((b) => JSON.parse(b))).toMatchObject([
			{
				kind: "limit",
				level: 95,
				title: "Codex at 96% of weekly limit",
				tag: "limit:codex:Weekly",
				url: "/#/usage",
			},
			{
				kind: "limit",
				level: 100,
				reached: true,
				title: "Codex hit its weekly limit",
			},
		]);
		expect(JSON.parse(bodies[1]!).body).toMatch(
			/^Agents pause for .+, until the limit resets\.$/,
		);
		expect(sent[0]!.headers.Topic).toBe("limit");
	});
});
