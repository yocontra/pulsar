import { canonicalJson, sha256hex } from "../canonical.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import { hostedWriter } from "./providers.ts";
import {
	type HostedProvider,
	type HostedWriteReceipt,
	hostedRequest,
} from "./wire.ts";

interface Stored {
	digest: string;
	receipt: HostedWriteReceipt;
	original?: string;
}

/** An uncertain provider response stays recorded. Neither a crash nor a retry can submit it again. */
export class HostedWrites {
	private readonly store: Pick<Store, "metaGet" | "metaSet" | "metaDelete">;
	private readonly writer: typeof hostedWriter;

	private readonly accepted?: (provider: HostedProvider) => void;

	constructor(
		store: HostedWrites["store"],
		writer = hostedWriter,
		accepted?: (provider: HostedProvider) => void,
	) {
		this.store = store;
		this.writer = writer;
		this.accepted = accepted;
	}

	private stored(key: string): Stored | null {
		const value = this.store.metaGet(key);
		return value ? (JSON.parse(value) as Stored) : null;
	}

	async run(login: string, raw: unknown): Promise<HostedWriteReceipt> {
		const parsed = hostedRequest.safeParse(raw);
		if (!parsed.success)
			throw new RpcError("bad_request", "Invalid hosted task parameters");
		const write = parsed.data;
		const owner = sha256hex(login.toLowerCase());
		const prefix = `hosted:receipt:${owner}:`;
		const key = prefix + write.nonce;
		const receiptOf = (stored: Stored) =>
			(stored.original && this.stored(prefix + stored.original)?.receipt) ||
			stored.receipt;
		if (write.action === "receipt") {
			const existing = this.stored(key);
			return existing ? receiptOf(existing) : { state: "not-found" };
		}
		const digest = sha256hex(canonicalJson(write));
		const existingReceipt = () => {
			const stored = this.stored(key);
			if (!stored) return null;
			if (stored.digest !== digest)
				throw new RpcError(
					"conflict",
					"This request ID belongs to a different hosted action",
				);
			return receiptOf(stored);
		};
		const existing = existingReceipt();
		if (existing) return existing;
		const submit = await this.writer(write.provider);
		// Another submission can reserve this nonce while credentials are resolved.
		const concurrent = existingReceipt();
		if (concurrent) return concurrent;
		const { nonce: _, ...action } = write;
		const target =
			"repo" in action
				? { ...action, repo: action.repo.toLowerCase() }
				: action;
		const fingerprint = `hosted:pending:${owner}:${sha256hex(canonicalJson(target))}`;
		const original = this.store.metaGet(fingerprint);
		if (original) {
			const pending = {
				digest,
				receipt: { state: "unknown" },
				original,
			} satisfies Stored;
			this.store.metaSet(key, JSON.stringify(pending));
			return receiptOf(pending);
		}
		if (!submit)
			throw new RpcError(
				"unsupported",
				"Set up this provider on the selected machine",
			);
		const record = (receipt: HostedWriteReceipt) =>
			this.store.metaSet(
				key,
				JSON.stringify({ digest, receipt } satisfies Stored),
			);
		const unknown = { state: "unknown" } as const;
		this.store.metaSet(fingerprint, write.nonce);
		record(unknown);
		try {
			const receipt = await submit(write);
			if (receipt?.state === "accepted" || receipt?.state === "rejected") {
				record(receipt);
				this.store.metaDelete(fingerprint);
				if (receipt.state === "accepted") this.accepted?.(write.provider);
				return receipt;
			}
		} catch {
			// A connection can fail after the provider accepted the request.
		}
		return unknown;
	}
}
