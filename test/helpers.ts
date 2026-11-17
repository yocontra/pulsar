import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/client.ts";
import { Daemon } from "../src/daemon.ts";
import type {
	DeliveredMessage,
	PublicAgent,
	Registration,
} from "../src/types.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";

/** A daemon on a private socket and database, with harness scanners off. */
export async function startDaemon() {
	const home = mkdtempSync(join(tmpdir(), "pulsar-test-"));
	process.env.PULSAR_HOME = home;
	const daemon = new Daemon({
		socket: join(home, "bus.sock"),
		db: join(home, "pulsar.db"),
		scan: false,
	});
	if (!(await daemon.start())) throw new Error("daemon did not start");
	return { daemon, home };
}

let pidCounter = 900_000;

export function registration(over: Partial<Registration> = {}): Registration {
	return {
		harness: "pi",
		sessionId: null,
		// Fake pids: the test agents are kept alive by their connections.
		pid: null,
		cwd: "/tmp/apparish",
		project: "apparish",
		branch: "main",
		tags: ["harness:pi", "project:apparish", "branch:main"],
		role: "extension",
		...over,
		...(over.sessionId === undefined && over.pid === undefined
			? { sessionId: `s${pidCounter++}` }
			: {}),
	};
}

/** Connects a fake agent. Extension-role agents receive pushes as `push` events. */
export async function agentClient(reg: Registration) {
	const client = new DaemonClient();
	await client.connect(false);
	const hello = await client.call<{ agent: PublicAgent }>("hello", {
		protocol: PROTOCOL_VERSION,
		registration: reg,
	});
	const pushes: Array<{ message: DeliveredMessage; text: string }> = [];
	const events: DeliveredMessage[] = [];
	client.on("push", (d) =>
		pushes.push(d as { message: DeliveredMessage; text: string }),
	);
	client.on("message", (d) => events.push(d as DeliveredMessage));
	return { client, agent: hello.agent, pushes, events };
}

export async function operator() {
	const client = new DaemonClient();
	await client.connect(false);
	await client.call("hello", {
		protocol: PROTOCOL_VERSION,
		registration: { role: "cli" },
	});
	return client;
}

export async function until(check: () => boolean, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("condition not met in time");
}
