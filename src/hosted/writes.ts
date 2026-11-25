import { canonicalJson, sha256hex } from "../canonical.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import { hostedWriter } from "./providers.ts";
import { type HostedWriteReceipt, hostedWrite } from "./wire.ts";

interface Stored {
	digest: string;
	receipt: HostedWriteReceipt;
}

/** An uncertain provider response stays recorded. Neither a crash nor a retry can submit it again. */
export class HostedWrites {
	private readonly store: Pick<
		Store,
		"metaByPrefix" | "metaSet" | "metaDelete"
	>;
	private readonly writer: typeof hostedWriter;

	constructor(store: HostedWrites["store"], writer = hostedWriter) {
		this.store = store;
		this.writer = writer;
	}

	async run(login: string, raw: unknown): Promise<HostedWriteReceipt> {
		const parsed = hostedWrite.safeParse(raw);
		if (!parsed.success)
			throw new RpcError("bad_request", "Invalid hosted task parameters");
		const write = parsed.data;
		const submit = await this.writer(write.provider);
		const owner = sha256hex(login.toLowerCase());
		const key = `hosted:receipt:${owner}:${write.nonce}`;
		const digest = sha256hex(canonicalJson(write));
		const existing = this.store
			.metaByPrefix(key)
			.find((row) => row.key === key);
		if (existing) {
			const stored: Stored = JSON.parse(existing.value);
			if (stored.digest !== digest)
				throw new RpcError(
					"conflict",
					"This request ID belongs to a different hosted action",
				);
			return stored.receipt;
		}
		const { nonce: _, ...action } = write;
		const target =
			"repo" in action
				? { ...action, repo: action.repo.toLowerCase() }
				: action;
		const fingerprint = `hosted:pending:${owner}:${sha256hex(canonicalJson(target))}`;
		if (
			this.store
				.metaByPrefix(fingerprint)
				.some((row) => row.key === fingerprint)
		)
			return { state: "unknown" };
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
			if (receipt && receipt.state !== "unknown") {
				record(receipt);
				this.store.metaDelete(fingerprint);
				return receipt;
			}
		} catch {
			// A connection can fail after the provider accepted the request.
		}
		return unknown;
	}
}
