import {
	ArrowUpRightIcon,
	ChevronDownIcon,
	PlusIcon,
	ReplyIcon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type {
	HostedProvider,
	HostedWrite,
	HostedWriteReceipt,
} from "../../../../src/hosted/wire.ts";
import { ApiError, api, ProveCancelled, request } from "../../api/client.ts";
import { hello } from "../../lib/store.ts";
import { providers, taskUrl } from "./providers.ts";

export function HostedAction({
	provider,
	machines,
	id,
	onAccepted,
	unavailable,
}: {
	provider: HostedProvider;
	machines: { machineId: string; name: string }[];
	id?: string;
	onAccepted: () => void;
	unavailable?: string;
}) {
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState(
		machines.length === 1 ? (machines[0]?.machineId ?? "") : "",
	);
	const [submission, setSubmission] = useState<{
		machine: string;
		params: HostedWrite;
	} | null>(null);
	const [receipt, setReceipt] = useState<HostedWriteReceipt | null>(null);
	const [error, setError] = useState("");
	const receiptUrl =
		receipt?.state === "accepted" ? taskUrl(receipt.url, provider) : undefined;
	const checking = !!submission && receipt?.state !== "not-found";
	const canSubmit = machines.length > 0;
	if (!canSubmit && !submission && !receipt && !open)
		return unavailable ? <p className="hosted-empty">{unavailable}</p> : null;

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
		if (
			!machine ||
			(!checking && !machines.some((m) => m.machineId === machine))
		)
			return;
		const intent = checking
			? { action: "receipt" as const, nonce: params.nonce }
			: params;
		const target = machine === hello.peek()?.machineId ? {} : { machine };
		setSubmission({ machine, params });
		if (!checking) setReceipt(null);
		setBusy(true);
		setError("");
		try {
			const result = await api.acting(
				"hosted.write",
				target,
				intent,
				(assertion) =>
					request<HostedWriteReceipt>("/hosted", {
						method: "POST",
						body: {
							...target,
							params: intent,
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
			if (
				!checking &&
				(e instanceof ProveCancelled ||
					(e instanceof ApiError && e.code === "bad_request"))
			)
				setSubmission(null);
			setError(
				e instanceof Error ? e.message : "Could not get a task receipt.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<details
			className="hosted-action"
			onToggle={(event) => {
				const expanded = event.currentTarget.open;
				setOpen(expanded);
				const onlyMachine =
					machines.length === 1 ? machines[0]?.machineId : undefined;
				if (expanded && !selected && onlyMachine) setSelected(onlyMachine);
			}}
		>
			<summary className="hosted-button">
				{id ? (
					<ReplyIcon aria-hidden="true" />
				) : (
					<PlusIcon aria-hidden="true" />
				)}
				{id ? "Follow up" : "New hosted task"}
				<ChevronDownIcon className="hosted-chevron" aria-hidden="true" />
			</summary>
			<form
				onSubmit={(event) => {
					void submit(event);
				}}
			>
				<fieldset
					disabled={
						busy || !!submission || !canSubmit || receipt?.state === "accepted"
					}
				>
					<label>
						Run from machine
						<select
							name="machine"
							required
							value={selected}
							onChange={(event) => setSelected(event.target.value)}
						>
							{!machines.some((m) => m.machineId === selected) && (
								<option value={selected} disabled>
									{selected
										? "Previous machine unavailable"
										: "Choose a machine"}
								</option>
							)}
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
								{provider === "copilot" ? "Branch (optional)" : "Branch"}
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
					<p className="hosted-form-note">
						GitHub Copilot can create a draft pull request in this repository.
					</p>
				)}
				{error && (
					<p className="hosted-notice" data-tone="issue" role="status">
						{error}
					</p>
				)}
				{receipt?.state === "not-found" && (
					<p className="hosted-notice" role="status">
						No receipt exists on the original machine. You can submit again from
						that machine when it is connected.
					</p>
				)}
				{receipt?.state === "unknown" && (
					<p className="hosted-notice" data-tone="issue" role="status">
						The provider may have accepted this request. Check the provider
						before starting another task.
					</p>
				)}
				{receipt?.state === "accepted" && (
					<p className="hosted-notice" data-tone="ready" role="status">
						Task accepted{receipt.id ? ` · ${receipt.id}` : ""}.
					</p>
				)}
				{receiptUrl && (
					<a
						className="hosted-button"
						href={receiptUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open in {providers[provider].name}
						<ArrowUpRightIcon aria-hidden="true" />
					</a>
				)}
				{receipt?.state === "rejected" && (
					<p role="status">
						The provider rejected this request (HTTP {receipt.status}).
					</p>
				)}
				{receipt?.state !== "accepted" && (
					<button
						type="submit"
						className="hosted-button hosted-primary"
						disabled={
							busy ||
							(!checking &&
								(!canSubmit ||
									(!!submission &&
										!machines.some((m) => m.machineId === submission.machine))))
						}
					>
						{busy
							? checking
								? "Checking…"
								: "Sending…"
							: checking
								? "Check receipt"
								: submission
									? "Submit again on same machine"
									: id
										? "Send follow-up"
										: "Start task"}
					</button>
				)}
				{receipt?.state === "accepted" && (
					<button
						type="button"
						className="hosted-button"
						onClick={() => setReceipt(null)}
					>
						{id ? "Send another follow-up" : "Start another task"}
					</button>
				)}
			</form>
		</details>
	);
}
