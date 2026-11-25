import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import type {
	HostedTaskDetail as Detail,
	HostedProvider,
	HostedReport,
} from "../../../../src/hosted/wire.ts";
import { request } from "../../api/client.ts";
import { queryClient } from "../../data/hooks.ts";
import { HostedAction } from "./HostedAction.tsx";
import { providers, taskUrl } from "./providers.ts";

export function HostedTaskDetail({
	provider,
	id,
	listedUrl,
	sources,
	onAccepted,
}: {
	provider: HostedProvider;
	id: string;
	listedUrl?: string;
	sources: HostedReport["machines"];
	onAccepted: () => void;
}) {
	const [machine, setMachine] = useState(sources[0]?.machineId ?? "");
	const [requested, setRequested] = useState("");
	const online = sources.some((s) => s.machineId === machine);
	function detailQuery(source: string) {
		return {
			queryKey: ["hosted-task", provider, id, source],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				request<Detail>(
					`/hosted/${provider}/tasks/${encodeURIComponent(id)}?${new URLSearchParams({ machine: source })}`,
					{ signal },
				),
			retry: false,
			staleTime: 0,
		};
	}

	const query = useQuery(
		{ ...detailQuery(requested), enabled: false },
		queryClient,
	);
	const detail = query.data;
	const href =
		detail?.state === "ready" && detail.detail.kind === "task"
			? taskUrl(detail.detail.task.url, provider)
			: undefined;
	const sourceLost =
		!!requested && !sources.some((s) => s.machineId === requested);
	const shown = requested === machine && !sourceLost;
	const ready =
		shown && !query.isFetching && !query.isError && detail?.state === "ready";
	const followUp =
		ready &&
		detail.detail.kind === "task" &&
		/^idle$/i.test(detail.detail.task.status);
	const followUpSources = sources.filter(
		(source) => followUp && source.machineId === requested,
	);
	const unavailable =
		detail?.state === "unavailable" && detail.reason === "source-unreachable"
			? "This machine is no longer available. Choose another connection or try again."
			: "Could not load provider details. The task information above is still available.";

	function load() {
		setRequested(machine);
		void queryClient.fetchQuery(detailQuery(machine)).catch(() => {
			// The observer renders request errors with the listing metadata.
		});
	}

	return (
		<div className="hosted-details-loader">
			{!sources.length && !requested ? (
				<p>No current connection to load provider details.</p>
			) : (
				<div className="hosted-details-controls">
					<label>
						Details from
						<select
							value={machine}
							onChange={(event) => setMachine(event.target.value)}
						>
							{!online && (
								<option value={machine}>
									{machine ? "Previous source unavailable" : "Choose a machine"}
								</option>
							)}
							{sources.map((source) => (
								<option key={source.machineId} value={source.machineId}>
									{source.name}
								</option>
							))}
						</select>
					</label>
					<button
						className="hosted-button"
						type="button"
						disabled={!online || query.isFetching}
						onClick={load}
					>
						{shown && query.isFetching ? "Loading…" : "Load provider details"}
					</button>
				</div>
			)}
			{sourceLost && (
				<p className="hosted-notice" data-tone="issue" role="status">
					The selected source is no longer current. Choose a connected machine
					to load details.
				</p>
			)}
			{shown && (query.isError || detail?.state === "unavailable") && (
				<p className="hosted-notice" data-tone="issue" role="status">
					{unavailable}
				</p>
			)}
			{shown &&
				!query.isError &&
				detail?.state === "ready" &&
				(detail.detail.kind === "text" ? (
					<div
						className="hosted-detail-scroll"
						role="region"
						aria-label="Provider output"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to the scrollable output.
						tabIndex={0}
					>
						<pre>{detail.detail.text}</pre>
					</div>
				) : (
					<div className="hosted-provider-result">
						<strong>{detail.detail.task.title}</strong>
						<p>
							{[detail.detail.task.status, detail.detail.task.context]
								.filter(Boolean)
								.join(" · ")}
						</p>
						{href && href !== listedUrl && (
							<a
								className="hosted-button"
								href={href}
								target="_blank"
								rel="noopener noreferrer"
							>
								Open in {providers[provider].name}
								<ArrowUpRightIcon aria-hidden="true" />
							</a>
						)}
					</div>
				))}
			{provider === "cursor" && (
				<HostedAction
					provider={provider}
					id={id}
					machines={followUpSources}
					onAccepted={() => {
						onAccepted();
						void query.refetch();
					}}
					unavailable={
						ready && !followUp
							? "Follow-up is available when the task is idle."
							: undefined
					}
				/>
			)}
		</div>
	);
}
