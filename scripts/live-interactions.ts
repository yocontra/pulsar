/**
 * Live check for interactions: a throwaway
 * daemon (run it with a temp PULSAR_HOME and PULSAR_NO_SCAN=1) that answers
 * relayed prompts in-process with a soft passkey, as the app would, and logs
 * every state change to $LIVE/events.log. $LIVE/policy.json steers it:
 * {"mode":"wait"} leaves prompts for the agent's own screen; otherwise it
 * answers after `delayMs` with `answer`, or a default per kind (`decision`
 * for permissions).
 *
 *   export LIVE=$(mktemp -d) PULSAR_HOME=$LIVE/home PULSAR_NO_SCAN=1
 *   bun scripts/live-interactions.ts &
 *   # omp: omp --no-extensions -e dist/extension.js [--approval-mode=always-ask]
 *   # Claude: claude --setting-sources project,local --settings <file with a
 *   #   PermissionRequest hook running `node dist/cli.js hook claude-permission`>
 *   # then ask the agent to use its ask/AskUserQuestion/plan tools and read events.log.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { Daemon } from "../src/daemon.ts";
import { SoftAuthenticator } from "../test/webauthn.ts";

const L = process.env.LIVE;
if (!L || !process.env.PULSAR_HOME)
	throw new Error("set LIVE and a temp PULSAR_HOME");
const log = (s: string) =>
	appendFileSync(`${L}/events.log`, `${new Date().toISOString()} ${s}\n`);
const d = new Daemon({
	scan: false,
	remote: { mode: "off" },
	approvals: { answerable: () => true },
	// Relays a scratch OpenCode server's prompts (run with its temp HOME).
	serverInteractions: true,
});
if (!(await d.start())) {
	log("start failed");
	process.exit(1);
}
const ORIGIN = "http://localhost:4100";
const rp = { rpId: "localhost", origins: [ORIGIN] };
const user = {
	kind: "human",
	login: "me@example.com",
	node: "phone",
	verified: true,
} as const;
const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: "localhost" });
const ap = d.service.approvals;
const reg = await ap.passkeys.registrationOptions(user.login, rp, {
	label: "iPhone",
	code: ap.passkeys.enrollCode().code,
});
await ap.passkeys.verifyRegistration(user.login, rp, auth.register(reg));
log("ready");
const seen = new Set<string>();
d.service.events.on("approval", async ({ approval: a }) => {
	log(
		`approval ${a.requestId} kind=${a.kind} tool=${a.tool} state=${a.state} outcome=${a.outcome ?? ""} prompt=${JSON.stringify(a.prompt ?? a.input).slice(0, 400)}`,
	);
	if (a.state !== "pending" || seen.has(a.requestId)) return;
	seen.add(a.requestId);
	let policy: Record<string, unknown> = {};
	try {
		policy = JSON.parse(readFileSync(`${L}/policy.json`, "utf8"));
	} catch {}
	if (policy.mode === "wait") return;
	await new Promise((r) => setTimeout(r, Number(policy.delayMs ?? 1500)));
	const p = a.prompt;
	let decision: string = "answer";
	let answer: unknown = policy.answer;
	if (!answer) {
		if (!p) decision = String(policy.decision ?? "allow-once");
		else if (p.kind === "select")
			answer = { kind: "select", value: p.options.at(-1)!.label };
		else if (p.kind === "confirm")
			answer = { kind: "confirm", confirmed: true };
		else if (p.kind === "input")
			answer = { kind: "input", value: "typed in the pulsar app" };
		else if (p.kind === "plan")
			answer = { kind: "plan", choice: p.choices.find((c) => c.approves)!.id };
		else if (p.kind === "question")
			answer = {
				kind: "question",
				answers: Object.fromEntries(
					p.questions.map((q) => [
						q.id,
						q.options.length
							? [q.options.at(-1)!.label]
							: ["typed in the pulsar app"],
					]),
				),
			};
	}
	try {
		const o = await ap.options(user, rp, a.requestId, decision as never, {
			answer,
		});
		const assertion = auth.assert(
			(o as { options: { challenge: string } }).options,
		);
		const r = await ap.decide(user, rp, a.requestId, {
			decision: decision as never,
			answer,
			assertion,
		});
		log(`decided ${a.requestId} won=${r.won} outcome=${r.approval.outcome}`);
	} catch (e) {
		log(`decide error ${(e as Error).message}`);
	}
});
await new Promise(() => {});
