/**
 * Client-only pending state: each optimistic send line (an event whose id
 * starts with `local:`) is sending, accepted by the daemon, or failed with a
 * retry; each Stop in flight. Only React is imported: the transcript
 * renderer reads it without loading the data layer.
 */
import { useSyncExternalStore } from "react";

/** Ids of lines the app shows before the daemon has them (optimistic sends). */
export const LOCAL_PREFIX = "local:";

export type LocalSendState = "sending" | "sent" | "failed";

export interface LocalSend {
	state: LocalSendState;
	/** Why it failed, for the bubble. */
	error?: string;
	/** Sends it again with the same client id (the daemon sends once). */
	retry: () => void;
	/** Removes the failed line. */
	discard: () => void;
}

const sends = new Map<string, LocalSend>();
const listeners = new Set<() => void>();

function notify() {
	for (const fn of listeners) fn();
}

export function setLocalSend(id: string, s: LocalSend | null) {
	if (s) sends.set(id, s);
	else if (!sends.delete(id)) return;
	notify();
}

export const localSend = (id: string): LocalSend | null =>
	sends.get(id) ?? null;

/**
 * A line still waiting for the daemon or failed: never expired, and a
 * failed one is never matched to a real line (it was not sent).
 */
export const localHeld = (id: string): LocalSendState | null =>
	sends.get(id)?.state ?? null;

/** Per optimistic line: the real line ids shown when it was added. */
const baselines = new Map<string, ReadonlySet<string>>();

export function setLocalBaseline(id: string, ids: ReadonlySet<string> | null) {
	if (ids) baselines.set(id, ids);
	else baselines.delete(id);
}

/** Real lines that were already shown when this line was added. */
export const localBaseline = (id: string): ReadonlySet<string> | undefined =>
	baselines.get(id);

function subscribe(fn: () => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** The send state of one transcript line; null for a real line. */
export function useLocalSend(id: string): LocalSend | null {
	// No server rendering: the "server" snapshot (static markup in tests) is
	// the same state.
	const get = () => localSend(id);
	return useSyncExternalStore(subscribe, get, get);
}

// ------------------------------------------------------------ stopping

/**
 * Agents with a Stop in flight. Stop is not optimistic: the row keeps its
 * state and shows "Stopping…" until the daemon answers (the turn may have
 * ended, or the passkey prompt may be cancelled).
 */
const stopping = new Set<string>();

export function setStopping(id: string, on: boolean) {
	if (on === stopping.has(id)) return;
	if (on) stopping.add(id);
	else stopping.delete(id);
	notify();
}

export const isStopping = (id: string) => stopping.has(id);

/** A send not yet accepted, a failed one (its text is only here), or a Stop in flight. */
export const sendsPending = () =>
	stopping.size > 0 || [...sends.values()].some((s) => s.state !== "sent");

export function useStopping(id: string): boolean {
	const get = () => stopping.has(id);
	return useSyncExternalStore(subscribe, get, get);
}

/**
 * A Stop asked for from outside the session (the tree's context menu). The
 * session header may still be loading its chunk when the event fires, so
 * it also takes the request when it mounts for that agent.
 */
let stopAsked: string | null = null;

export function askStop(id: string) {
	stopAsked = id;
	dispatchEvent(new Event("pulsar:stop"));
}

/** True once for the agent a Stop was asked for. */
export function takeStopAsk(id: string): boolean {
	if (stopAsked !== id) return false;
	stopAsked = null;
	return true;
}
