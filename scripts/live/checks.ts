/**
 * Live checks across two pulsar nodes, run from this Mac:
 *
 *   bun scripts/live/checks.ts [--no-pause]
 *
 * Talks to both nodes' APIs over Tailscale as you (no passkey session), and
 * touches only the fake agents (tag `live-test`) on the remote node; your
 * real agents are only listed. `--no-pause` skips the link-drop test (which
 * runs `docker pause` on the container).
 *
 * `VIA_CONTAINER=<name>` sends every request from inside that container (as
 * user `dev`) instead: for a tailnet this Mac is not on, such as the
 * Headscale rig (scripts/live/headscale.sh). `VIA_CA` names the root the
 * requests trust there.
 */
import { execFile, execFileSync } from "node:child_process";

const MAC =
	process.env.MAC_URL ?? "https://contra-m2-mbp.taile9c930.ts.net:7337";
const REMOTE =
	process.env.REMOTE_URL ?? "https://pulsar-meshnode.taile9c930.ts.net:7337";
const REMOTE_MACHINE = process.env.REMOTE_MACHINE ?? "pulsar-meshnode";
const CONTAINER = process.env.CONTAINER ?? "pulsar-meshnode";
const FAKE = `machine=${REMOTE_MACHINE} live-test`;
const pause = !process.argv.includes("--no-pause");

let failed = 0;
function result(ok: boolean, name: string, detail = "") {
	if (!ok) failed++;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
}

const VIA = process.env.VIA_CONTAINER;
/** Runs inside the container: one request from stdin, `{status, text}` out. */
const VIA_SCRIPT = `let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const r=JSON.parse(s);const res=await fetch(r.url,r.init);process.stdout.write(JSON.stringify({status:res.status,text:await res.text()}));});`;

function viaFetch(
	url: string,
	init: RequestInit,
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const p = execFile(
			"docker",
			[
				"exec",
				"-i",
				"-u",
				"dev",
				...(process.env.VIA_CA
					? ["-e", `NODE_EXTRA_CA_CERTS=${process.env.VIA_CA}`]
					: []),
				VIA!,
				"node",
				"-e",
				VIA_SCRIPT,
			],
			{ maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => {
				if (err) reject(err);
				else resolve(JSON.parse(stdout) as { status: number; text: string });
			},
		);
		p.stdin?.end(JSON.stringify({ url, init }));
	});
}

async function api<T = Record<string, unknown>>(
	base: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
	if (VIA) {
		const r = await viaFetch(`${base}/api/v1${path}`, {
			method: init.method ?? "GET",
			headers: {
				"X-Pulsar": "1",
				...(init.body !== undefined
					? { "Content-Type": "application/json" }
					: {}),
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		});
		let body: unknown = r.text;
		try {
			body = JSON.parse(r.text);
		} catch {}
		return { status: r.status, body: body as T };
	}
	const res = await fetch(`${base}/api/v1${path}`, {
		method: init.method ?? "GET",
		headers: {
			"X-Pulsar": "1",
			...(init.body !== undefined
				? { "Content-Type": "application/json" }
				: {}),
		},
		...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: res.status, body: body as T };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
	what: () => Promise<T | null | undefined | false>,
	ms: number,
): Promise<T | null> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await what();
		if (v) return v;
		await sleep(1000);
	}
	return null;
}

interface Row {
	id: string;
	address: string;
	name: string;
	machine?: string;
	state: string;
}

async function fakeAgents(base: string): Promise<Row[]> {
	const r = await api<{ items: Row[] }>(
		base,
		`/agents?selector=${encodeURIComponent(FAKE)}&limit=100&sort=name`,
	);
	return r.body.items ?? [];
}

// 1. Both nodes answer and see each other (the remote node may still be linking).
await until(async () => {
	const h = await api<{ machines: number }>(MAC, "/hello");
	return h.body.machines >= 2;
}, 60_000);
for (const [label, base] of [
	["Mac", MAC],
	["remote", REMOTE],
] as const) {
	const h = await api<{ machine: string; machines: number; version: string }>(
		base,
		"/hello",
	);
	result(
		h.status === 200 && h.body.machines >= 2,
		`${label} /hello: ${h.body.machine} pulsar ${h.body.version}, ${h.body.machines} machines`,
	);
	const tree = await api<{ items: { label: string; link: string }[] }>(
		base,
		"/tree?group=machines",
	);
	const names = (tree.body.items ?? []).map((n) => `${n.label}(${n.link})`);
	result(
		names.length >= 2,
		`${label} pool tree lists both machines`,
		names.join(", "),
	);
}

// 2. The remote node's fake agents, seen from the Mac.
const remote = await until(async () => {
	const rows = await fakeAgents(MAC);
	return rows.length > 0 ? rows : null;
}, 30_000);
result(
	Boolean(remote),
	"Mac lists the remote fake agents",
	`${remote?.length ?? 0}`,
);
const by = (name: string) => remote?.find((a) => a.name === name);
const reviewer = by("reviewer");
const fixer = by("fixer");
if (!reviewer || !fixer) {
	console.log(
		"fake agents missing on the remote node; run fake-agents.ts there",
	);
	process.exit(1);
}

// 3. Cross-machine send, receipt and reply.
async function sendAndWaitReply(body: string, ms: number) {
	const s = await api<{ message: { id: string } }>(MAC, "/send", {
		method: "POST",
		body: { ids: [reviewer!.id], body, expectReply: true },
	});
	if (s.status !== 200) return { status: s.status, id: null, reply: null };
	const id = s.body.message.id;
	const reply = await until(async () => {
		const r = await api<{
			items: { state: string; reply?: string }[];
		}>(MAC, `/messages/${encodeURIComponent(id)}/receipts`);
		return r.body.items?.find((i) => i.reply)?.reply ?? null;
	}, ms);
	return { status: s.status, id, reply };
}
const sent = await sendAndWaitReply(`live check ${Date.now()}`, 30_000);
result(
	Boolean(sent.reply?.startsWith("reviewer got:")),
	"Mac → remote send: receipt and reply come back",
	sent.reply ?? `status ${sent.status}`,
);

// 4. Ask across machines (nobody is woken).
const ask = await api<{
	matches: { agent: { name: string; machine?: string }; evidence: string[] }[];
}>(MAC, "/ask", {
	method: "POST",
	body: { question: "who is editing src/auth/session.ts" },
});
const hit = ask.body.matches?.find((m) => m.agent.name === "fixer");
result(
	Boolean(
		hit?.evidence.some((e) => e.startsWith("Edited src/auth/session.ts")),
	),
	"Ask on the Mac finds the remote fixer with evidence",
	hit?.evidence.join("; ") ?? JSON.stringify(ask.body).slice(0, 200),
);

// 5. The remote agent's transcript, read through the Mac.
const page = await api<{ events: { text: string }[]; available: boolean }>(
	MAC,
	`/agents/${encodeURIComponent(fixer.id)}/transcript`,
);
const texts = (page.body.events ?? []).map((e) => e.text).join("\n");
result(
	page.status === 200 &&
		texts.includes("refresh") &&
		texts.includes("live line"),
	"remote transcript through the Mac (history + live lines)",
	`${page.body.events?.length ?? 0} events`,
);

// 6. Stop without a passkey session is refused.
const stop = await api<{ error?: { code: string } }>(
	MAC,
	`/agents/${encodeURIComponent(reviewer.id)}/stop`,
	{ method: "POST", body: {} },
);
result(
	stop.status === 401 && stop.body.error?.code === "session_required",
	"stop of a remote agent without a session → 401 session_required",
	`${stop.status} ${stop.body.error?.code ?? ""}`,
);

// 7. Broadcast dry run to the remote fake agents.
const dry = await api<{
	count: number;
	breakdown: { machine: string; count: number }[];
}>(MAC, "/send", {
	method: "POST",
	body: { to: FAKE, body: "dry", dryRun: true },
});
result(
	dry.status === 200 &&
		dry.body.count === remote!.length &&
		dry.body.breakdown?.[0]?.machine === REMOTE_MACHINE,
	"broadcast dry run counts the remote fake agents per machine",
	`${dry.body.count} on ${dry.body.breakdown?.map((b) => b.machine).join(",")}`,
);

// 8. Link drop: pause the container, send, unpause, the outbox delivers.
if (pause) {
	execFileSync("docker", ["pause", CONTAINER]);
	console.log(`… ${CONTAINER} paused`);
	let sentWhilePaused: Awaited<ReturnType<typeof sendAndWaitReply>> | null =
		null;
	try {
		const s = await api<{
			message: { id: string };
			receipts: { state: string; detail: string | null }[];
		}>(MAC, "/send", {
			method: "POST",
			body: {
				ids: [reviewer.id],
				body: `while away ${Date.now()}`,
				expectReply: true,
			},
		});
		const first = s.body.receipts?.[0];
		result(
			s.status === 200,
			"send while the remote node is away is accepted",
			`${first?.state ?? s.status} ${first?.detail ?? ""}`,
		);
		sentWhilePaused = {
			status: s.status,
			id: s.body.message?.id ?? null,
			reply: null,
		};
		await sleep(5000);
	} finally {
		execFileSync("docker", ["unpause", CONTAINER]);
		console.log(`… ${CONTAINER} unpaused`);
	}
	const id = sentWhilePaused?.id;
	const reply = id
		? await until(async () => {
				const r = await api<{ items: { reply?: string }[] }>(
					MAC,
					`/messages/${encodeURIComponent(id)}/receipts`,
				);
				return r.body.items?.find((i) => i.reply)?.reply ?? null;
			}, 120_000)
		: null;
	result(
		Boolean(reply),
		"after unpause the outbox delivers and the reply comes back",
		reply ?? "no reply within 120 s",
	);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
