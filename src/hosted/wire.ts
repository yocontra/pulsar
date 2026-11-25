import { z } from "zod";

export const HOSTED_PROVIDERS = ["copilot", "codex", "cursor"] as const;
export const hostedProvider = z.enum(HOSTED_PROVIDERS);
export type HostedProvider = z.infer<typeof hostedProvider>;

export const hostedId = z
	.string()
	.regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/);

const hostedTask = z.object({
	id: hostedId,
	title: z.string().max(500),
	status: z.string().max(80),
	context: z.string().max(500).nullable(),
	url: z.string().max(2048).nullable(),
	updatedAt: z.number().int().nonnegative().nullable(),
});

export type HostedTask = z.infer<typeof hostedTask>;

export const hostedObservation = z.object({
	provider: hostedProvider,
	state: z.enum(["ready", "stale", "unavailable"]),
	observedAt: z.number().int().nonnegative().nullable(),
	detail: z.enum(["not-configured", "read-failed"]).nullable(),
	tasks: z.array(hostedTask).max(30),
});

export const hostedObservations = z
	.array(hostedObservation)
	.max(HOSTED_PROVIDERS.length);
export type HostedObservation = z.infer<typeof hostedObservation>;

export interface HostedMachine {
	machineId: string;
	name: string;
	state: "reachable" | "offline" | "unavailable";
	providers: HostedObservation[];
}

export interface HostedReport {
	machines: Omit<HostedMachine, "providers">[];
	providers: (Omit<HostedObservation, "tasks"> & { machineId: string })[];
	tasks: (HostedTask & {
		provider: HostedProvider;
		sources: { machineId: string; state: HostedMachine["state"] | "stale" }[];
	})[];
}

const prompt = z
	.string()
	.trim()
	.min(1)
	.max(30_000)
	.refine((s) => !s.includes("\0"));
const repo = z
	.string()
	.regex(/^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/);
const ref = z.string().regex(/^[A-Za-z0-9][\w./-]{0,200}$/);
const nonce = z.uuid().toLowerCase();

export const hostedWrite = z.union([
	z.strictObject({
		nonce,
		provider: z.literal("copilot"),
		action: z.literal("create"),
		prompt,
		repo,
		ref: ref.optional(),
	}),
	z.strictObject({
		nonce,
		provider: z.literal("codex"),
		action: z.literal("create"),
		prompt,
		environment: hostedId,
		ref,
	}),
	z.strictObject({
		nonce,
		provider: z.literal("cursor"),
		action: z.literal("create"),
		prompt,
		repo,
		ref,
	}),
	z.strictObject({
		nonce,
		provider: z.literal("cursor"),
		action: z.literal("follow-up"),
		prompt,
		id: hostedId.regex(/^bc-[0-9a-f-]+$/i),
	}),
]);
export type HostedWrite = z.infer<typeof hostedWrite>;

export const hostedRequest = z.union([
	hostedWrite,
	z.strictObject({ action: z.literal("receipt"), nonce }),
]);

export type HostedWriteReceipt =
	| { state: "not-found" }
	| { state: "unknown" }
	| { state: "rejected"; status: number }
	| { state: "accepted"; id: string | null; runId?: string; url?: string };

export const hostedDetailParams = z.strictObject({
	provider: hostedProvider,
	id: hostedId,
	machine: z
		.string()
		.regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/)
		.optional(),
});

export const hostedTaskDetail = z.discriminatedUnion("state", [
	z.object({
		state: z.literal("ready"),
		provider: hostedProvider,
		id: hostedId,
		machineId: z.string().min(1).max(200),
		detail: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("task"), task: hostedTask }),
			z.object({
				kind: z.literal("text"),
				text: z.string().min(1).max(32_000),
			}),
		]),
	}),
	z.object({
		state: z.literal("unavailable"),
		provider: hostedProvider,
		id: hostedId,
		machineId: z.string().min(1).max(200),
		reason: z.enum(["source-unreachable", "read-failed"]),
	}),
]);

export type HostedTaskDetail = z.infer<typeof hostedTaskDetail>;
