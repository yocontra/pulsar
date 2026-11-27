import { DaemonClient } from "../client.ts";
import { startNativeWake } from "../native-wake.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { antigravityBinding } from "./antigravity-wake.ts";

type HookOutput = { injectSteps?: Array<{ userMessage: string }> };
type HookMessage = { id: string; text: string };

/** Antigravity reads one JSON object from stdout before it invokes the model. */
export async function antigravitySessionHook(
	raw: string,
	write: (result: HookOutput) => Promise<void>,
) {
	const client = new DaemonClient();
	let messages: HookMessage[] = [];
	try {
		const input = JSON.parse(raw);
		const start = input.hookEventName === "SessionStart";
		if (
			(start || input.hookEventName === "PreInvocation") &&
			typeof input.conversationId === "string"
		) {
			const binding = await antigravityBinding(input.conversationId);
			if (binding) {
				await startNativeWake("antigravity", binding.sessionId, binding);
				await client.connect(false);
				const { agent } = await client.call<{ agent: { id: string } }>(
					"hello",
					{
						protocol: PROTOCOL_VERSION,
						registration: {
							harness: "antigravity",
							role: "cli",
							pid: binding.pid,
							sessionId: binding.sessionId,
							cwd: binding.cwd,
							project: null,
							branch: null,
							tags: [],
						},
					},
					1000,
				);
				if (agent.id === `antigravity:${binding.sessionId}`) {
					({ messages } = await client.call<{ messages: HookMessage[] }>(
						"native.hook.collect",
						{
							pid: binding.pid,
							sessionId: binding.sessionId,
							first: start || input.invocationNum === 0,
						},
						1000,
					));
				}
			}
		}
	} catch {
		// A missing daemon or an unidentified session must never block the host.
	}
	try {
		await write(
			messages.length
				? { injectSteps: messages.map(({ text }) => ({ userMessage: text })) }
				: {},
		);
		await Promise.allSettled(
			messages.map(({ id }) =>
				client.call("ack", { messageId: id, via: "native-hook" }, 500),
			),
		);
	} finally {
		client.close();
	}
}
