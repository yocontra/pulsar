import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Identity, IdentityProvider } from "../src/http/identity.ts";
import type {
	Approval,
	DecideResponse,
	PasskeyRegisterResponse,
	SessionVerifyResponse,
} from "../src/http/wire.ts";
import type { HookDecision } from "../src/service/approvals.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * Prove Human once: a prompt on this machine can be answered with the
 * browser's passkey session instead of a fresh passkey signature, bound to
 * the exact prompt (its input hash, and for "allow-session" its rules).
 */

const OWNER = "me@example.com";
const MAC: Identity = {
	login: OWNER,
	node: "macbook",
	nodeId: "nMAC",
	displayName: "Ada Lovelace",
	os: "macOS",
};
const PHONE: Identity = { ...MAC, node: "iphone", nodeId: "nPHONE", os: "iOS" };

let current: Identity = MAC;
const identity: IdentityProvider = { identify: async () => current };

let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
let origin: string;
let agentId: string;
let token = "";
let sessionId = "";

type Err = { error: { code: string; message: string } };

async function api<T = Record<string, unknown>>(
	as: Identity,
	method: string,
	path: string,
	body?: unknown,
	bearer?: string,
): Promise<{ status: number; body: T }> {
	current = as;
	const res = await fetch(`${base}/api/v1${path}`, {
		method,
		headers: {
			"X-Pulsar": "1",
			Connection: "close",
			Origin: origin,
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	return { status: res.status, body: (await res.json()) as T };
}

let turn = 0;
function ask(command: string, rules = false) {
	const ac = new AbortController();
	const caller: Caller = {
		principal: { kind: "agent", agentId },
		closed: ac.signal,
		emit() {},
	};
	const decision = service.approvals.request(caller, {
		sessionId: "web-1",
		promptId: `turn-${++turn}`,
		tool: "Bash",
		input: { command },
		suggestions: rules
			? [
					{
						type: "addRules",
						rules: [{ toolName: "Bash", ruleContent: "git init *" }],
						behavior: "allow",
						destination: "localSettings",
					},
				]
			: [],
		cwd: "/repo",
		transcriptPath: null,
	});
	const a = service.approvals.pendingFor(agentId).at(-1)!;
	return {
		a,
		path: `/approvals/${encodeURIComponent(a.requestId)}`,
		decision,
		close: () => ac.abort(),
	};
}

beforeAll(async () => {
	store = new Store(":memory:");
	service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null, answerable: () => true },
	});
	agentId = service.registry.upsert({
		harness: "claude",
		sessionId: "web-1",
		pid: null,
		cwd: "/repo",
		project: "repo",
		branch: "main",
		tags: [],
		meta: {},
		registered: true,
	}).id;
	http = new HttpTransport(service, {
		identity,
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
	});
	await http.listen();
	base = `http://127.0.0.1:${http.port}`;
	origin = `http://localhost:${http.port}`;
	// One Prove Human on the Mac: registering starts its session.
	const key = new SoftAuthenticator({ origin, rpId: "localhost" });
	const o = await api<{ options: unknown }>(
		MAC,
		"POST",
		"/passkeys/register/options",
		{ label: "Mac" },
	);
	const r = await api<PasskeyRegisterResponse>(
		MAC,
		"POST",
		"/passkeys/register/verify",
		{ response: key.register(o.body.options as never) },
	);
	expect(r.status).toBe(200);
	token = r.body.token;
	sessionId = r.body.session.id;
});

afterAll(async () => {
	await http.close();
	service.stop();
	store.close();
});

describe("answering with the passkey session", () => {
	test("a session answers a prompt on this machine, bound to its input hash; audited as the session", async () => {
		const p = ask("echo once");
		const d = await api<DecideResponse>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ decision: "allow-once", inputHash: p.a.inputHash },
			token,
		);
		expect(d.status).toBe(200);
		expect(d.body.won).toBe(true);
		expect(d.body.approval.outcome).toMatch(/passkey session on Mac/);
		expect((await p.decision) as HookDecision).toEqual({ behavior: "allow" });
		const row = store.db
			.prepare(
				"SELECT detail FROM audit WHERE op = 'approval.decide' AND target = ? ORDER BY at DESC LIMIT 1",
			)
			.get(p.a.requestId) as { detail: string };
		expect(row.detail).toContain(`session:${sessionId}`);
	});

	test("a different input hash is refused, and the prompt stays pending", async () => {
		const p = ask("rm -rf build");
		const d = await api<Err>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ decision: "allow-once", inputHash: "0".repeat(64) },
			token,
		);
		expect(d.status).toBe(403);
		expect(d.body.error.code).toBe("bad_assertion");
		const missing = await api<Err>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ decision: "deny" },
			token,
		);
		expect(missing.status).toBe(403);
		const got = await api<Approval>(MAC, "GET", p.path);
		expect(got.body.state).toBe("pending");
		p.close();
		await p.decision;
	});

	test("allow-session needs the exact rules the card listed", async () => {
		const p = ask("git init -q", true);
		expect(p.a.sessionRules).toEqual(["Bash(git init *)"]);
		const wrong = await api<Err>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{
				decision: "allow-session",
				inputHash: p.a.inputHash,
				sessionRules: ["Bash(*)"],
			},
			token,
		);
		expect(wrong.status).toBe(403);
		const ok = await api<DecideResponse>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{
				decision: "allow-session",
				inputHash: p.a.inputHash,
				sessionRules: p.a.sessionRules,
			},
			token,
		);
		expect(ok.status).toBe(200);
		expect(ok.body.won).toBe(true);
		await p.decision;
	});

	test("a replayed session decision loses: first answer wins, once", async () => {
		const p = ask("echo replay");
		const body = { decision: "deny", inputHash: p.a.inputHash };
		const first = await api<DecideResponse>(
			MAC,
			"POST",
			`${p.path}/decide`,
			body,
			token,
		);
		expect(first.body.won).toBe(true);
		const again = await api<DecideResponse>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ ...body, decision: "allow-once" },
			token,
		);
		expect(again.status).toBe(200);
		expect(again.body.won).toBe(false);
		expect(again.body.approval.state).toBe("denied");
		expect((await p.decision) as HookDecision).toMatchObject({
			behavior: "deny",
		});
	});

	test("no session, a made-up token, or the token from another device: refused", async () => {
		const p = ask("echo nobody");
		const body = { decision: "allow-once", inputHash: p.a.inputHash };
		const none = await api<Err>(MAC, "POST", `${p.path}/decide`, body);
		expect(none.status).toBe(401);
		expect(none.body.error.code).toBe("session_required");
		const fake = await api<Err>(
			MAC,
			"POST",
			`${p.path}/decide`,
			body,
			"x".repeat(43),
		);
		expect(fake.status).toBe(401);
		// The Mac's token copied to the phone (another tailnet node) is worthless.
		const copied = await api<Err>(
			PHONE,
			"POST",
			`${p.path}/decide`,
			body,
			token,
		);
		expect(copied.status).toBe(401);
		expect(copied.body.error.code).toBe("session_required");
		expect((await api<Approval>(MAC, "GET", p.path)).body.state).toBe(
			"pending",
		);
		p.close();
		await p.decision;
	});

	test("a forwarded decision (federation) can't stand on a session", async () => {
		const p = ask("echo forwarded");
		await expect(
			service.approvals.decide(
				{ kind: "human", login: OWNER, name: "Ada", node: "macbook" } as never,
				{ rpId: "localhost", origins: [origin] },
				p.a.requestId,
				{ decision: "allow-once", inputHash: p.a.inputHash },
			),
		).rejects.toMatchObject({ code: "session_required" });
		p.close();
		await p.decision;
	});

	test("a revoked session can't answer", async () => {
		const p = ask("echo revoked");
		expect(
			(await api(MAC, "POST", `/sessions/${sessionId}/revoke`, {}, token))
				.status,
		).toBe(200);
		const d = await api<Err>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ decision: "allow-once", inputHash: p.a.inputHash },
			token,
		);
		expect(d.status).toBe(401);
		expect(d.body.error.code).toBe("session_required");
		p.close();
		await p.decision;
	});

	describe("presence checks answered with the passkey session", () => {
		// Its own Prove Human (an earlier test revokes the shared session).
		let fresh = "";
		beforeAll(async () => {
			const key = new SoftAuthenticator({ origin, rpId: "localhost" });
			const o = await api<{ options: unknown }>(
				MAC,
				"POST",
				"/passkeys/register/options",
				{ label: "Mac presence" },
			);
			const r = await api<PasskeyRegisterResponse>(
				MAC,
				"POST",
				"/passkeys/register/verify",
				{ response: key.register(o.body.options as never) },
			);
			fresh = r.body.token;
		});

		function confirmCard() {
			const ac = new AbortController();
			const caller: Caller = {
				principal: { kind: "agent", agentId },
				closed: ac.signal,
				emit() {},
			};
			const confirmed = service.presence.confirm(caller, {
				op: "pool.forget",
				text: "forget ci",
				target: "ci",
			});
			// Awaited later; a no rejects it before then.
			confirmed.catch(() => {});
			const a = service.approvals.pendingFor(agentId).at(-1)!;
			return {
				a,
				confirmed,
				path: `/approvals/${encodeURIComponent(a.requestId)}`,
			};
		}

		test("a session answers a presence card on this machine, bound to its action and card text", async () => {
			const p = confirmCard();
			expect(p.a.kind).toBe("confirm");
			// A card hash from some other action or text: refused.
			const wrong = await api<Err>(
				MAC,
				"POST",
				`${p.path}/decide`,
				{
					decision: "answer",
					answer: { kind: "confirm", confirmed: true },
					inputHash: "0".repeat(64),
				},
				fresh,
			);
			expect(wrong.body.error.code).toBe("bad_assertion");
			const ok = await api<DecideResponse>(
				MAC,
				"POST",
				`${p.path}/decide`,
				{
					decision: "answer",
					answer: { kind: "confirm", confirmed: true },
					inputHash: p.a.inputHash,
				},
				fresh,
			);
			expect(ok.body.won).toBe(true);
			expect((await p.confirmed).method).toBe("passkey session");
		});

		test("no session: a presence card can't be answered without a passkey", async () => {
			const p = confirmCard();
			const none = await api<Err>(MAC, "POST", `${p.path}/decide`, {
				decision: "answer",
				answer: { kind: "confirm", confirmed: true },
				inputHash: p.a.inputHash,
			});
			expect(none.body.error.code).toBe("session_required");
			const no = await api<DecideResponse>(
				MAC,
				"POST",
				`${p.path}/decide`,
				{
					decision: "answer",
					answer: { kind: "confirm", confirmed: false },
					inputHash: p.a.inputHash,
				},
				fresh,
			);
			expect(no.body.won).toBe(true);
			await expect(p.confirmed).rejects.toMatchObject({ code: "denied" });
		});
	});
});

describe("the device a decision names", () => {
	let syncedKey: SoftAuthenticator | null = null;
	let macToken = "";
	test("a passkey registered as iPhone and synced to a Mac: the session and its decisions name the Mac", async () => {
		// The iPhone registered this passkey; iCloud Keychain syncs it, and
		// the Mac's browser signs with the same credential.
		const synced = new SoftAuthenticator({ origin, rpId: "localhost" });
		syncedKey = synced;
		const rp = { rpId: "localhost", origins: [origin] };
		await service.approvals.passkeys.verifyRegistration(
			OWNER,
			rp,
			synced.register(
				await service.approvals.passkeys.registrationOptions(OWNER, rp, {
					label: "iPhone",
				}),
			),
		);
		const o = await api<{ requestId: string; options: never }>(
			MAC,
			"POST",
			"/session/options",
			{ device: "Mac" },
		);
		expect(o.status).toBe(200);
		const s = await api<SessionVerifyResponse>(MAC, "POST", "/session/verify", {
			requestId: o.body.requestId,
			assertion: synced.assert(o.body.options),
		});
		expect(s.status).toBe(200);
		expect(s.body.session.device).toBe("Mac");
		expect(s.body.session.node).toBe("macbook");
		macToken = s.body.token;

		const p = ask("echo synced");
		const d = await api<DecideResponse>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ decision: "allow-once", inputHash: p.a.inputHash },
			s.body.token,
		);
		expect(d.body.won).toBe(true);
		expect(d.body.approval.outcome).toMatch(
			/^Allowed once by Ada Lovelace · passkey session on Mac \(macbook\) · \d\d:\d\d$/,
		);
		expect(d.body.approval.outcome).not.toContain("iPhone");
		await p.decision;
	});

	test("a signed answer from the Mac with the iPhone's passkey names the Mac and Touch ID", async () => {
		const p = ask("echo signed");
		const o = await api<{ options: never }>(MAC, "POST", `${p.path}/options`, {
			decision: "allow-once",
		});
		// The passkey registered as iPhone in the test above.
		const synced = syncedKey!;
		const d = await api<DecideResponse>(MAC, "POST", `${p.path}/decide`, {
			decision: "allow-once",
			assertion: synced.assert(o.body.options),
		});
		expect(d.body.won).toBe(true);
		expect(d.body.approval.outcome).toMatch(
			/^Allowed once by Ada Lovelace · Touch ID on Mac \(macbook\) · \d\d:\d\d$/,
		);
		await p.decision;
	});

	test("rows decided before the prover's device was stored: no device, and no method guessed from a passkey label", async () => {
		const p = ask("echo legacy");
		const d = await api<DecideResponse>(
			MAC,
			"POST",
			`${p.path}/decide`,
			{ decision: "allow-once", inputHash: p.a.inputHash },
			macToken,
		);
		expect(d.body.won).toBe(true);
		await p.decision;
		const id = d.body.approval.requestId;
		const outcome = (device: string, method: string) => {
			store.db
				.prepare(
					"UPDATE approvals SET decided_on = NULL, decided_device = ?, decided_method = ? WHERE id = ?",
				)
				.run(device, method, id);
			return service.approvals.get(id)?.outcome;
		};
		expect(outcome("iPhone", "passkey session")).toMatch(
			/^Allowed once by Ada Lovelace · passkey session · \d\d:\d\d$/,
		);
		expect(outcome("iPhone", "Face ID")).toMatch(
			/^Allowed once by Ada Lovelace · passkey · \d\d:\d\d$/,
		);
	});
});
