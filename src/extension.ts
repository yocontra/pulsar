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
import { gitInfo } from "./git.ts";
import { extensionHostFor } from "./harnesses/index.ts";
import { daemonLog } from "./log.ts";
import { autoTags, envTags } from "./tags.ts";
import type { DeliveredMessage, Registration } from "./types.ts";
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

function cliPath(): string {
	const js = fileURLToPath(new URL("./cli.js", import.meta.url));
	return js;
}

export default function pulsarExtension(pi: HostApi) {
	const host = extensionHostFor(process.argv.join(" "));
	const harness = host?.id ?? "unknown";
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

	// Acks lost with a dropped connection; each is sent once more after reconnect.
	const pendingAcks = new Set<string>();

	function ack(messageId: string, retry: boolean) {
		client.call("ack", { messageId, via: "extension" }).catch((e) => {
			if (retry) pendingAcks.add(messageId);
			else
				daemonLog(
					`extension ack for ${messageId} failed: ${(e as Error).message}`,
				);
		});
	}

	async function connect() {
		await client.connect(true);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: registration(),
		});
		for (const id of pendingAcks) ack(id, false);
		pendingAcks.clear();
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
			ack(message.id, true);
		} catch (e) {
			// The daemon puts it back in the inbox.
			client
				.call("nack", { messageId: message.id, reason: (e as Error).message })
				.catch(() => {});
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
	// Report the model after each reply, so `model=…` selectors find this agent.
	let lastModel: string | null = null;
	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; model?: string } })
			?.message;
		if (
			message?.role !== "assistant" ||
			!message.model ||
			message.model === lastModel
		)
			return;
		lastModel = message.model;
		if (client.connected)
			client.call("set_identity", { model: message.model }).catch(() => {});
	});
	for (const event of host?.extension?.idleEvents ?? [])
		pi.on(event, () => setStatus("idle"));
	pi.on("session_shutdown", (event) => {
		if ((event as { reason?: string })?.reason === "quit") {
			stopped = true;
			client.close();
		}
	});
}
