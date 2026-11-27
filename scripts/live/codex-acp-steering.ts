import { readFile } from "node:fs/promises";
import { codexRolloutAsync } from "../../src/harnesses/codex.ts";

/** Hold the initial model call until Pulsar receives the in-turn handoff receipt.
 * A harmless plan tool gives Codex a second inference within the same turn. */
export function steeringFixture() {
	const start = "PULSAR_STEERING_ORIGINAL";
	const urgent = "PULSAR_STEERING_URGENT";
	const reply = "PULSAR_STEERING_CONFIRMED";
	const gate = Promise.withResolvers<void>();
	let waiting = false;
	let sawUrgent = false;
	return {
		start,
		urgent,
		reply,
		held: () => waiting,
		sawUrgent: () => sawUrgent,
		release: () => gate.resolve(),
		async intercept(input: string) {
			if (!input.includes(start)) return null;
			if (input.includes(urgent)) {
				sawUrgent = true;
				return {
					type: "message",
					id: "steered",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: reply, annotations: [] }],
				};
			}
			if (waiting) return null;
			waiting = true;
			await gate.promise;
			return {
				type: "function_call",
				name: "update_plan",
				call_id: "fixture-plan",
				arguments: JSON.stringify({
					plan: [{ step: "Check steering", status: "completed" }],
				}),
			};
		},
	};
}

export async function nativeTurns(sessionId: string): Promise<string[]> {
	const file = await codexRolloutAsync(sessionId);
	if (!file) return [];
	const ids = [];
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (!line.includes('"task_started"')) continue;
		try {
			const row = JSON.parse(line);
			if (
				row.type === "event_msg" &&
				row.payload?.type === "task_started" &&
				typeof row.payload.turn_id === "string"
			)
				ids.push(row.payload.turn_id);
		} catch {}
	}
	return ids;
}
