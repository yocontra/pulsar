import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { builtCli, startDaemon } from "./helpers.ts";
import { FakePresence } from "./presence-fake.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * The converted commands, run the way an agent runs them: the built CLI as a
 * child process with no terminal (stdin closed, as Claude Code's `!` and an
 * agent's Bash tool run it), speaking as that agent. The daemon runs in this
 * process with a scripted OS prompt, or with the app path and a software
 * passkey.
 */

const ORIGIN = "http://localhost:4100";
const rp = { rpId: "localhost", origins: [ORIGIN] };
const user = {
	kind: "human" as const,
	login: "me@example.com",
	node: "phone",
	verified: true,
};

const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const s of stops.splice(0)) await s();
});

async function daemon(native: FakePresence | null) {
	const d = await startDaemon({
		machine: "studio",
		approvals: { answerable: () => true, probe: () => null },
		presence: { native },
	});
	stops.push(async () => {
		await d.daemon.stop();
		d.cleanup();
	});
	return d;
}

/** Runs `pulsar …` as agent `session` of pi, with no terminal. */
function cli(home: string, args: string[], session = "agent-shell") {
	const child = spawn(process.execPath, [builtCli(), ...args], {
		env: {
			...process.env,
			PULSAR_HOME: home,
			PULSAR_HARNESS: "pi",
			PULSAR_SESSION_ID: session,
			PULSAR_NO_SCAN: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => {
		out += d;
	});
	child.stderr.on("data", (d) => {
		err += d;
	});
	const done = new Promise<{ code: number | null; out: string; err: string }>(
		(resolve) => child.on("close", (code) => resolve({ code, out, err })),
	);
	return { done, stderr: () => err };
}

async function enroll(
	service: import("../src/service/index.ts").PulsarService,
	label: string,
) {
	const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: "localhost" });
	const options = await service.approvals.passkeys.registrationOptions(
		user.login,
		rp,
		{
			label,
		},
	);
	await service.approvals.passkeys.verifyRegistration(
		user.login,
		rp,
		auth.register(options),
	);
	return auth;
}

async function until(check: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("condition not met in time");
}

describe("sensitive commands from an agent's shell (no terminal)", () => {
	test("`pulsar mesh owner`: Touch ID yes applies it, no refuses it; the prompt names the agent", async () => {
		const native = new FakePresence("denied", "granted");
		const { daemon: d, home } = await daemon(native);
		const no = await cli(home, ["mesh", "owner", "me@example.com"]).done;
		expect(no.code).toBe(1);
		expect(no.err).toContain(
			"Not confirmed: make me@example.com the pool owner",
		);
		expect(d.service.poolMembers.owner).toBeNull();
		const yes = await cli(home, ["mesh", "owner", "me@example.com"]).done;
		expect(yes.err).toContain(
			'waiting for you to confirm "make me@example.com the pool owner',
		);
		expect(yes.err).toContain("(Touch ID or the Pulsar app)");
		expect(yes.code).toBe(0);
		expect(yes.out).toContain("confirmed with Touch ID");
		expect(d.service.poolMembers.owner).toBe("me@example.com");
		// It was asked by the agent whose shell ran it, by name.
		expect(native.shown[1]).toMatch(/asked by agent \S+ \(pi\) on studio/);
	}, 30_000);

	test("`pulsar passkeys remove`: confirmed in the app with a passkey", async () => {
		const { daemon: d, home } = await daemon(null);
		const auth = await enroll(d.service, "iPhone");
		await enroll(d.service, "MacBook");
		const mac = d.service.approvals.passkeys
			.list()
			.find((k) => k.label === "MacBook")!;
		const run = cli(home, ["passkeys", "remove", mac.id], "agent-shell-2");
		const pending = () =>
			d.service.app.views.attention().items.filter((i) => i.approval);
		await until(() => pending().length === 1);
		// The CLI says where to confirm. Its stderr reaches us through a pipe,
		// which on a loaded machine can trail the card the daemon already shows.
		await until(() => run.stderr().includes("(the Pulsar app)"));
		const card = pending()[0]!.approval!;
		expect(card.prompt).toMatchObject({
			kind: "confirm",
			title: `Confirm: remove passkey 'MacBook' (${mac.id.slice(0, 8)})`,
		});
		const answer = { kind: "confirm", confirmed: true };
		const options = await d.service.approvals.options(
			user,
			rp,
			card.requestId,
			"answer",
			{
				answer,
			},
		);
		await d.service.approvals.decide(user, rp, card.requestId, {
			decision: "answer",
			answer,
			assertion: auth.assert((options as { options: never }).options),
		});
		const r = await run.done;
		expect(r.code).toBe(0);
		expect(r.out).toContain(`Removed passkey ${mac.id}`);
		expect(d.service.approvals.passkeys.list().map((k) => k.label)).toEqual([
			"iPhone",
		]);
	}, 30_000);

	test("`pulsar passkeys remove`: a no in the app refuses", async () => {
		const { daemon: d, home } = await daemon(null);
		const auth = await enroll(d.service, "iPhone");
		const id = d.service.approvals.passkeys.list()[0]!.id;
		const run = cli(home, ["passkeys", "remove", id], "agent-shell-3");
		const pending = () =>
			d.service.app.views.attention().items.filter((i) => i.approval);
		await until(() => pending().length === 1);
		const card = pending()[0]!.approval!;
		const answer = { kind: "confirm", confirmed: false };
		const options = await d.service.approvals.options(
			user,
			rp,
			card.requestId,
			"answer",
			{
				answer,
			},
		);
		await d.service.approvals.decide(user, rp, card.requestId, {
			decision: "answer",
			answer,
			assertion: auth.assert((options as { options: never }).options),
		});
		const r = await run.done;
		expect(r.code).toBe(1);
		expect(r.err).toContain("Not confirmed: remove passkey 'iPhone'");
		expect(d.service.approvals.passkeys.list().length).toBe(1);
	}, 30_000);

	test("`pulsar mesh allow`, `deny` and `forget` from an agent's shell, each confirmed", async () => {
		const native = new FakePresence("granted", "granted", "granted");
		const { daemon: d, home } = await daemon(native);
		const ci = {
			nodeId: "nCi",
			name: "ci",
			dnsName: "ci.tail1234.ts.net",
			userId: null,
			login: "tagged-devices",
			tags: ["tag:ci"],
			online: true,
		};
		const self = {
			...ci,
			nodeId: "nSelf",
			name: "studio",
			dnsName: "studio.tail1234.ts.net",
			userId: "7",
			login: "me@example.com",
			tags: [],
			ownerLogin: "me@example.com",
		};
		d.service.poolStatus = async () => ({ self, peers: [ci] });
		const verdict = () =>
			d.service.poolMembers.entries().find((e) => e.nodeId === "nCi")
				?.verdict ?? null;
		const allow = await cli(home, ["mesh", "allow", "ci"], "pool-shell").done;
		expect(allow.code).toBe(0);
		expect(verdict()).toBe("allow");
		const deny = await cli(home, ["mesh", "deny", "ci"], "pool-shell").done;
		expect(deny.code).toBe(0);
		expect(verdict()).toBe("deny");
		const forget = await cli(home, ["mesh", "forget", "ci"], "pool-shell").done;
		expect(forget.code).toBe(0);
		expect(forget.out).toContain("Done: forget ci");
		expect(verdict()).toBeNull();
		expect(
			native.shown.map((r) => r.split(":")[1]?.trim().split(" ")[0]),
		).toEqual(["allow", "deny", "forget"]);
	}, 30_000);
});
