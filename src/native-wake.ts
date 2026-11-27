import { fork } from "node:child_process";
import { DaemonClient } from "./client.ts";
import {
	antigravityBinding,
	type NativeBinding,
	serveAntigravityWake,
} from "./harnesses/antigravity-wake.ts";
import type { PublicAgent } from "./types.ts";

/** Only the session that owns a native host connection starts a wake worker. */
export async function startNativeWake(
	harness: string,
	sessionId: string | null,
	existing?: NativeBinding,
): Promise<void> {
	if (
		harness !== "antigravity" ||
		!sessionId ||
		!process.env.ANTIGRAVITY_LS_ADDRESS
	)
		return;
	const client = new DaemonClient();
	try {
		await client.connect(false);
		const agents = await client.call<PublicAgent[]>(
			"list",
			{ selector: `${harness}:${sessionId}` },
			500,
		);
		if (
			agents.some(
				(a) =>
					a.id === `${harness}:${sessionId}` &&
					a.capabilities?.childWake === true,
			)
		)
			return;
	} catch {
		/* The worker can reconnect to a restarting daemon. */
	} finally {
		client.close();
	}
	const binding = existing ?? (await antigravityBinding(sessionId));
	if (!binding || binding.rootSessionId) return;
	const worker = fork(process.argv[1]!, ["worker", "native-wake"], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		execArgv: [],
	});
	worker.on("error", () => {});
	await new Promise<void>((resolve, reject) =>
		worker.send({ harness, binding }, (err) => (err ? reject(err) : resolve())),
	);
	worker.channel?.unref();
	worker.unref();
}

export async function runNativeWakeWorker(): Promise<void> {
	const packet = await new Promise<{ harness: string; binding: NativeBinding }>(
		(resolve, reject) => {
			process.once("message", resolve);
			process.once("disconnect", () =>
				reject(new Error("Native wake session closed.")),
			);
		},
	);
	process.disconnect?.();
	if (packet?.harness !== "antigravity" || !packet.binding) return;
	await serveAntigravityWake(packet.binding);
}
