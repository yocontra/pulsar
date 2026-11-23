import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UsageRoots } from "../src/usage/scan.ts";

/** Session-file lines as each harness writes them (only the fields usage reads, plus noise). */

export function claudeLine(o: {
	id: string;
	t: number;
	model?: string;
	input?: number;
	read?: number;
	w5m?: number;
	w1h?: number;
	output?: number;
	cwd?: string;
	block?: string;
}): string {
	return JSON.stringify({
		parentUuid: null,
		isSidechain: false,
		cwd: o.cwd ?? "/work/app",
		timestamp: new Date(o.t).toISOString(),
		type: "assistant",
		message: {
			model: o.model ?? "claude-opus-5-5",
			id: o.id,
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: o.block ?? "hello" }],
			usage: {
				input_tokens: o.input ?? 10,
				cache_creation_input_tokens: (o.w5m ?? 0) + (o.w1h ?? 0),
				cache_read_input_tokens: o.read ?? 0,
				output_tokens: o.output ?? 5,
				cache_creation: {
					ephemeral_5m_input_tokens: o.w5m ?? 0,
					ephemeral_1h_input_tokens: o.w1h ?? 0,
				},
			},
		},
	});
}

/** A user line that mentions "usage" in its text (must not count). */
export function claudeUserLine(t: number): string {
	return JSON.stringify({
		type: "user",
		timestamp: new Date(t).toISOString(),
		message: { role: "user", content: 'what is "usage" here?' },
	});
}

export function codexLines(
	t: number,
	model: string,
	totals: [input: number, cached: number, output: number][],
	window = 400_000,
): string[] {
	const ts = (i: number) => new Date(t + i * 1000).toISOString();
	const out = [
		JSON.stringify({
			timestamp: ts(0),
			type: "session_meta",
			payload: { id: "x", cwd: "/work/api" },
		}),
		JSON.stringify({
			timestamp: ts(0),
			type: "turn_context",
			payload: { cwd: "/work/api", model },
		}),
	];
	let prev: [number, number, number] = [0, 0, 0];
	totals.forEach(([input, cached, output], i) => {
		const last = {
			input_tokens: input - prev[0],
			cached_input_tokens: cached - prev[1],
			output_tokens: output - prev[2],
			reasoning_output_tokens: 0,
			total_tokens: input - prev[0] + output - prev[2],
		};
		out.push(
			JSON.stringify({
				timestamp: ts(i + 1),
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: input,
							cached_input_tokens: cached,
							output_tokens: output,
							reasoning_output_tokens: 0,
							total_tokens: input + output,
						},
						last_token_usage: last,
						model_context_window: window,
					},
				},
			}),
		);
		prev = [input, cached, output];
	});
	return out;
}

export function piLines(
	t: number,
	model: string,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	}[],
): string[] {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			timestamp: new Date(t).toISOString(),
			cwd: "/work/tool",
		}),
		...usage.map((u, i) =>
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				timestamp: new Date(t + i * 1000).toISOString(),
				message: {
					role: "assistant",
					content: [],
					provider: "anthropic",
					model,
					usage: { ...u, totalTokens: 0, cost: { total: 0 } },
				},
			}),
		),
	];
}

export function write(file: string, lines: string[], partial = "") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, lines.map((l) => `${l}\n`).join("") + partial);
}

export function append(file: string, text: string) {
	appendFileSync(file, text);
}

export function rootsIn(dir: string): UsageRoots {
	return {
		claude: join(dir, "claude", "projects"),
		codex: join(dir, "codex", "sessions"),
		pi: join(dir, "pi", "sessions"),
		omp: join(dir, "omp", "sessions"),
		claudeState: join(dir, "claude", ".claude.json"),
		opencodeDb: join(dir, "opencode", "opencode.db"),
	};
}

/**
 * Plan limit lines, shaped like real session files (read-only samples;
 * account details removed).
 */

/** Codex: a `token_count` event with `rate_limits` (resets_at in seconds). */
export function codexLimitLine(o: {
	t: number;
	used: number;
	resetsAt: number;
	minutes?: number;
	secondary?: { used: number; minutes: number; resetsAt: number } | null;
	reachedType?: string | null;
}): string {
	return JSON.stringify({
		timestamp: new Date(o.t).toISOString(),
		type: "event_msg",
		payload: {
			type: "token_count",
			info: null,
			rate_limits: {
				limit_id: "codex",
				limit_name: null,
				primary: {
					used_percent: o.used,
					window_minutes: o.minutes ?? 10080,
					resets_at: Math.floor(o.resetsAt / 1000),
				},
				secondary: o.secondary
					? {
							used_percent: o.secondary.used,
							window_minutes: o.secondary.minutes,
							resets_at: Math.floor(o.secondary.resetsAt / 1000),
						}
					: null,
				credits: { has_credits: false, unlimited: false, balance: "0" },
				individual_limit: null,
				spend_control_reached: null,
				plan_type: "pro",
				rate_limit_reached_type: o.reachedType ?? null,
			},
		},
	});
}

/** Claude Code: the placeholder reply when the plan's limit is reached. */
export function claudeLimitLine(o: {
	t: number;
	resetsAt: number;
	type?: string;
}): string {
	const info = {
		status: "rejected",
		resetsAt: Math.floor(o.resetsAt / 1000),
		rateLimitType: o.type ?? "seven_day",
		overageStatus: "rejected",
		isUsingOverage: false,
	};
	return JSON.stringify({
		isSidechain: false,
		type: "assistant",
		timestamp: new Date(o.t).toISOString(),
		message: {
			model: "<synthetic>",
			role: "assistant",
			content: [
				{ type: "text", text: "You've hit your weekly limit · resets 7pm" },
			],
			usage: { input_tokens: 0, output_tokens: 0 },
		},
		apiError: "usage_limit_reached",
		apiErrorParams: { rate_limit_info: info },
		quotaLimits: { ...info, upgradePaths: ["overage"] },
		error: "rate_limit",
		isApiErrorMessage: true,
		apiErrorStatus: 429,
	});
}

/** pi/omp: an assistant error with status 429 and the provider's limit message. */
export function piLimitLine(o: {
	t: number;
	retryMs: number;
	text?: string;
	status?: number;
}): string {
	return JSON.stringify({
		type: "message",
		id: "e1",
		timestamp: new Date(o.t).toISOString(),
		message: {
			role: "assistant",
			content: [],
			provider: "example-go",
			model: "m-flash",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "error",
			timestamp: o.t - 900,
			errorStatus: o.status ?? 429,
			errorMessage:
				o.text ??
				`429 Example usage limit reached (weekly, resets in 3d 17h). Turn on extra usage at https://example.com/console/org_x. retry-after-ms=${o.retryMs}`,
			completedAt: o.t,
		},
	});
}
