/**
 * pulsar extension for pi and omp.
 *
 * pi and omp have no outside door into a running session, so this extension
 * opens one: it keeps a connection to the pulsar daemon and injects messages
 * with `sendMessage`, waking an idle session. It also reports busy/idle, and
 * on pi it registers the pulsar MCP server so the agent gets the tools too.
 */
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./client.ts";
import { autoTags, envTags, gitInfo } from "./identity.ts";
import type { DeliveredMessage, Harness, Registration } from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";
import { VERSION } from "./version.ts";

/** The subset of the pi / omp ExtensionAPI this extension uses. */
interface HostApi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: { triggerTurn?: boolean; deliverAs?: string },
	): unknown;
	registerMcpServer?: (
		name: string,
		config: { command: string; args: string[]; env?: Record<string, string> },
	) => void;
}

function hostHarness(): Harness {
	const argv = process.argv.join(" ");
	return /oh-my-pi|(^|\/)omp(\s|$)/.test(argv) ? "omp" : "pi";
}

function cliPath(): string {
	const js = fileURLToPath(new URL("./cli.js", import.meta.url));
	return js;
}

export default function pulsarExtension(pi: HostApi) {
	const harness = hostHarness();
	const client = new DaemonClient();
	let stopped = false;

	const registration = (): Registration => {
		const cwd = process.cwd();
		const git = gitInfo(cwd);
		return {
			harness,
			// pid-based identity: the MCP server finds the same pid as its parent.
			sessionId: null,
			pid: process.pid,
			cwd,
			project: git.project,
			branch: git.branch,
			tags: [...autoTags(harness, git), ...envTags()],
			role: "extension",
		};
	};

	async function connect() {
		await client.connect(true);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: registration(),
		});
	}

	function reconnectLater(delay = 500) {
		if (stopped) return;
		setTimeout(() => {
			connect().catch(() => reconnectLater(Math.min(delay * 2, 15_000)));
		}, delay).unref();
	}

	client.onClose(() => reconnectLater());

	client.on("push", (data) => {
		const { message, text } = data as {
			message: DeliveredMessage;
			text: string;
		};
		try {
			pi.sendMessage(
				{
					customType: "pulsar",
					content: text,
					display: true,
					details: { id: message.id, from: message.from.name },
				},
				{
					triggerTurn: true,
					deliverAs: message.priority === "urgent" ? "steer" : "followUp",
				},
			);
		} catch {
			// The daemon keeps the message queued; it shows in `inbox`.
		}
	});

	const setStatus = (status: "busy" | "idle") => {
		if (client.connected) client.call("set_status", { status }).catch(() => {});
	};

	pi.on("session_start", async () => {
		if (pi.registerMcpServer) {
			try {
				pi.registerMcpServer("pulsar", {
					command: process.execPath,
					args: [cliPath(), "mcp"],
					env: { PULSAR_HARNESS: harness },
				});
			} catch {
				// A `pulsar` entry in mcp.json takes precedence; that is fine.
			}
		}
		if (!client.connected) await connect().catch(() => reconnectLater());
	});
	pi.on("agent_start", () => setStatus("busy"));
	pi.on("agent_settled", () => setStatus("idle"));
	if (harness === "omp") pi.on("agent_end", () => setStatus("idle"));
	pi.on("session_shutdown", (event) => {
		if ((event as { reason?: string })?.reason === "quit") {
			stopped = true;
			client.close();
		}
	});
}
