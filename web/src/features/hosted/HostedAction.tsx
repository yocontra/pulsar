import { type FormEvent, useState } from "react";
import type {
	HostedProvider,
	HostedWrite,
	HostedWriteReceipt,
} from "../../../../src/hosted/wire.ts";
import { ApiError, api, request } from "../../api/client.ts";
import { hello } from "../../lib/store.ts";

export function HostedAction({
	provider,
	machines,
	id,
	onAccepted,
}: {
	provider: HostedProvider;
	machines: { machineId: string; name: string }[];
	id?: string;
	onAccepted: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [submission, setSubmission] = useState<{
		machine: string;
		params: HostedWrite;
	} | null>(null);
	const [receipt, setReceipt] = useState<HostedWriteReceipt | null>(null);
	const [error, setError] = useState("");
	if (!machines.length && !submission) return null;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || receipt?.state === "accepted") return;
		const form = event.currentTarget;
		const fields = new FormData(form);
		const ref = String(fields.get("ref") ?? "").trim();
		const context = String(fields.get("context") ?? "").trim();
		const prompt = String(fields.get("prompt") ?? "").trim();
		if (!submission && !prompt) {
			setError("Enter a task prompt.");
			return;
		}
		const base = { nonce: crypto.randomUUID(), prompt };
		const params: HostedWrite =
			submission?.params ??
			(id
				? { ...base, provider: "cursor", action: "follow-up", id }
				: provider === "codex"
					? { ...base, provider, action: "create", environment: context, ref }
					: provider === "cursor"
						? { ...base, provider, action: "create", repo: context, ref }
						: {
								...base,
								provider,
								action: "create",
								repo: context,
								...(ref ? { ref } : {}),
							});
		const machine = submission?.machine ?? String(fields.get("machine") ?? "");
		if (!machine) return;
		const target = machine === hello.peek()?.machineId ? {} : { machine };
		setSubmission({ machine, params });
		setBusy(true);
		setError("");
		try {
			const result = await api.acting(
				"hosted.write",
				target,
				params,
				(assertion) =>
					request<HostedWriteReceipt>("/hosted", {
						method: "POST",
						body: {
							...target,
							params,
							...(assertion !== undefined ? { assertion } : {}),
						},
					}),
			);
			setReceipt(result);
			if (result.state === "rejected") setSubmission(null);
			if (result.state === "accepted") {
				form.reset();
				setSubmission(null);
				onAccepted();
			}
		} catch (e) {
			if (e instanceof ApiError && e.code === "bad_request")
				setSubmission(null);
			setError(
				e instanceof Error ? e.message : "Could not get a task receipt.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<details className="hosted-action">
			<summary>{id ? "Send follow-up" : "New hosted task"}</summary>
			<form
				onSubmit={(event) => {
					void submit(event);
				}}
			>
				<fieldset disabled={busy || !!submission}>
					<label>
						Credential machine
						<select name="machine" required>
							{machines.map((m) => (
								<option key={m.machineId} value={m.machineId}>
									{m.name}
								</option>
							))}
						</select>
					</label>
					{!id && (
						<>
							<label>
								{provider === "codex" ? "Environment ID" : "GitHub repository"}
								<input
									name="context"
									placeholder={
										provider === "codex" ? undefined : "owner/repository"
									}
									required
								/>
							</label>
							<label>
								Branch
								<input name="ref" required={provider !== "copilot"} />
							</label>
						</>
					)}
					<label>
						Prompt
						<textarea name="prompt" maxLength={30_000} required />
					</label>
				</fieldset>
				{provider === "copilot" && (
					<p>
						GitHub Copilot can create a draft pull request in this repository.
					</p>
				)}
				{error && <p role="status">{error}</p>}
				{receipt?.state === "unknown" && (
					<p role="status">
						The provider may have accepted this request. Check the provider
						before starting another task.
					</p>
				)}
				{receipt?.state === "accepted" && (
					<p role="status">
						Task accepted{receipt.id ? ` · ${receipt.id}` : ""}.
					</p>
				)}
				{receipt?.state === "rejected" && (
					<p role="status">
						Cursor rejected this request (HTTP {receipt.status}).
					</p>
				)}
				{receipt?.state !== "accepted" && (
					<button type="submit" disabled={busy}>
						{busy
							? "Sending…"
							: submission
								? receipt?.state === "unknown"
									? "Check receipt"
									: "Retry on same machine"
								: id
									? "Send follow-up"
									: "Start task"}
					</button>
				)}
				{receipt?.state === "accepted" && (
					<button type="button" onClick={() => setReceipt(null)}>
						Start another
					</button>
				)}
			</form>
		</details>
	);
}
