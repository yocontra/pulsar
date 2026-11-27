import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import {
	acpTranscriptPath,
	acpUsagePath,
} from "../harnesses/acp-transcript.ts";
import type { UsageCostSource } from "../http/wire.ts";

interface Session {
	harness: string;
	sessionId: string;
}

export interface AcpUsage {
	context: { used: number; window: number } | null;
	cost: {
		amount: number;
		source: Extract<UsageCostSource, "estimated" | "reported">;
	} | null;
}

type AcpUsageUpdate = {
	used: number;
	size: number;
	cost?: { amount: number; currency: string } | null;
};

function pathOf({ harness, sessionId }: Session) {
	return acpUsagePath(acpTranscriptPath(harness, sessionId));
}

function costOf(value: unknown): AcpUsage["cost"] {
	const cost = value as Partial<NonNullable<AcpUsage["cost"]>> | null;
	if (
		!cost ||
		typeof cost.amount !== "number" ||
		!Number.isFinite(cost.amount) ||
		cost.amount < 0 ||
		(cost.source !== "reported" && cost.source !== "estimated")
	)
		return null;
	return { amount: cost.amount, source: cost.source };
}

function contextOf(used: unknown, window: unknown): AcpUsage["context"] {
	return typeof used === "number" &&
		Number.isSafeInteger(used) &&
		used >= 0 &&
		typeof window === "number" &&
		Number.isSafeInteger(window) &&
		window > 0
		? { used, window }
		: null;
}

export async function loadAcpUsage(session: Session): Promise<AcpUsage | null> {
	try {
		const value = JSON.parse(
			await readFile(pathOf(session), "utf8"),
		) as Partial<AcpUsage>;
		return {
			context: contextOf(value?.context?.used, value?.context?.window),
			cost: costOf(value?.cost),
		};
	} catch {
		return null;
	}
}

/**
 * ACP reports current context and an optional cumulative session amount.
 * Store the snapshot separately from native token history. Context is not
 * billable token usage and a cumulative amount has no per-hour attribution.
 */
export async function saveAcpUsage(
	session: Session,
	update: AcpUsageUpdate,
): Promise<AcpUsage | null> {
	const context = contextOf(update.used, update.size);
	if (!context && update.cost === undefined) return null;
	const previous =
		!context || update.cost === undefined ? await loadAcpUsage(session) : null;
	const cost =
		update.cost === undefined
			? (previous?.cost ?? null)
			: update.cost?.currency === "USD"
				? costOf({
						amount: update.cost.amount,
						source: "reported",
					})
				: null;

	const path = pathOf(session);
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	const snapshot = { context: context ?? previous?.context ?? null, cost };
	try {
		await writeFile(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
		await rename(temporaryPath, path);
		return snapshot;
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

/** Serialize writes, retaining the latest context and explicit cost patch. */
export class AcpUsageWriter {
	private readonly session: Session;
	private readonly observed: () => void;
	private pending?: AcpUsageUpdate;
	private drain?: Promise<void>;

	constructor(session: Session, observed: () => void) {
		this.session = session;
		this.observed = observed;
	}

	add(update: AcpUsageUpdate) {
		const previous = this.pending;
		const validContext = contextOf(update.used, update.size);
		if (!validContext && update.cost === undefined) return;
		this.pending = {
			used: validContext ? update.used : (previous?.used ?? update.used),
			size: validContext ? update.size : (previous?.size ?? update.size),
			cost: update.cost === undefined ? previous?.cost : update.cost,
		};
		this.drain ??= this.flush();
	}

	finish(): Promise<void> | undefined {
		return this.drain;
	}

	private async flush() {
		while (this.pending) {
			const update = this.pending;
			this.pending = undefined;
			try {
				const saved = await saveAcpUsage(this.session, update);
				if (saved?.context || saved?.cost) this.observed();
			} catch (error) {
				console.error("ACP usage snapshot write failed", error);
			}
		}
		this.drain = undefined;
	}
}
