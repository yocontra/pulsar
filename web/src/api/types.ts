/**
 * The app's view of the pulsar HTTP API (`/api/v1`). Every wire shape comes
 * from the daemon's own definition (`src/http/wire.ts`), shared with the
 * development mock; this file adds only client-side shapes.
 */
import type {
	AgentRow,
	MachineCount,
	ReceiptState,
	ReconfirmCode,
	Wake,
} from "../../../src/http/wire.ts";

export type * from "../../../src/http/wire.ts";

export const API_BASE = "/api/v1";
/** Every request carries this header; the daemon refuses requests without it. */
export const API_HEADER = "X-Pulsar";

/**
 * A dry run, a real send, or a `/send` 409, normalized for the composer and
 * the builder's confirmation dialog.
 */
export interface SendResult {
	/** Absent on a dry run. */
	messageId?: string;
	total: number;
	machines: number;
	/** Per-machine counts for the breakdown dialog. */
	breakdown: MachineCount[];
	/** Dry run: predicted wakeability. Send: receipt counts so far. */
	counts: Partial<Record<Wake | ReceiptState, number>>;
	/** Dry run only. Send it back; a >5% drift at send asks again. */
	resolveToken?: string;
	/** Send only: true when the daemon asked to confirm again (409). */
	drift?: boolean;
	/** Which 409 asked for (re)confirmation. */
	reconfirm?: ReconfirmCode;
	/** Dry run: first recipients. */
	preview?: AgentRow[];
}
