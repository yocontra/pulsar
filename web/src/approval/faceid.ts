/**
 * Whether answering a prompt asks for Face ID / Touch ID: a prompt on
 * another machine is signed per answer, and a browser not proven yet makes
 * its passkey first. A local prompt in a proven browser goes with the
 * passkey session, so its buttons don't promise a Face ID check.
 */
import { useEffect, useState } from "react";
import type { Approval } from "../api/types.ts";
import { proven } from "../prove/state.ts";

export function useAsksFaceId(ap: Pick<Approval, "requestId">): boolean {
	const [isProven, setProven] = useState(proven.peek());
	useEffect(() => proven.subscribe(() => setProven(proven.peek())), []);
	return ap.requestId.includes("/") || !isProven;
}

/** "Allow once · Face ID" when it asks for Face ID, else "Allow once". */
export const faceIdLabel = (label: string, asks: boolean) =>
	asks ? `${label} · Face ID` : label;
