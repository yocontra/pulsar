import { useQuery } from "@tanstack/react-query";
import {
	ArrowUpRightIcon,
	ChevronDownIcon,
	CloudIcon,
	RefreshCwIcon,
	SearchIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type {
	HostedProvider,
	HostedReport,
} from "../../../../src/hosted/wire.ts";
import { request } from "../../api/client.ts";
import { queryClient } from "../../data/hooks.ts";
import { HostedAction } from "./HostedAction.tsx";
import { HostedTaskDetail } from "./HostedTaskDetail.tsx";
import { providers, taskUrl } from "./providers.ts";
import "./hosted.css";

const providerIds = Object.keys(providers) as HostedProvider[];
type Task = HostedReport["tasks"][number];
type Machine = HostedReport["machines"][number];

function timestamp(ms: number | null) {
	if (ms === null || !Number.isFinite(new Date(ms).getTime())) return null;
	const date = new Date(ms);
	return (
		<time dateTime={date.toISOString()}>
			{date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
		</time>
	);
}

function taskStatus(status: string) {
	return /^[A-Z_]+$/.test(status)
		? status.toLowerCase().replaceAll("_", " ")
		: status;
}

function taskTone(status: string) {
	if (/^(completed?|finished|succeeded|success)$/i.test(status)) return "ready";
	if (/^(failed|error|cancelled|canceled)$/i.test(status)) return "issue";
	if (/^(running|queued|in[_ -]?progress|creating)$/i.test(status))
		return "active";
	return "neutral";
}

function sourceStatus(state: Task["sources"][number]["state"]) {
	switch (state) {
		case "reachable":
			return "Current";
		case "stale":
			return "Last known";
		case "offline":
			return "Offline";
		case "unavailable":
			return "Unavailable";
	}
}

function TaskRow({
	task,
	machines,
	available,
	refresh,
	hidden,
	canWrite,
}: {
	task: Task;
	machines: Map<string, Machine>;
	available: Machine[];
	refresh: () => void;
	hidden: boolean;
	canWrite: boolean;
}) {
	const [hasOpened, setHasOpened] = useState(false);
	const href = taskUrl(task.url, task.provider);
	const current =
		canWrite &&
		task.sources.some(
			(s) =>
				s.state === "reachable" &&
				machines.get(s.machineId)?.state === "reachable",
		);
	const origins = available.filter((m) =>
		task.sources.some(
			(s) => s.machineId === m.machineId && s.state === "reachable",
		),
	);
	return (
		<li className="hosted-task" hidden={hidden}>
			<details
				onToggle={(event) => {
					if (event.currentTarget.open) setHasOpened(true);
				}}
			>
				<summary className="hosted-task-summary">
					<span className="hosted-task-label">
						<strong>{task.title}</strong>
						{task.context && <span>{task.context}</span>}
					</span>
					<span className="hosted-task-meta">
						{task.status && (
							<span className="hosted-badge" data-tone={taskTone(task.status)}>
								{taskStatus(task.status)}
							</span>
						)}
						{!current && (
							<span className="hosted-badge" data-tone="issue">
								Last known
							</span>
						)}
					</span>
					<ChevronDownIcon className="hosted-chevron" aria-hidden="true" />
				</summary>
				<div className="hosted-task-detail">
					<dl>
						<div>
							<dt>Task ID</dt>
							<dd>{task.id}</dd>
						</div>
						{task.updatedAt !== null && (
							<div>
								<dt>Updated</dt>
								<dd>{timestamp(task.updatedAt)}</dd>
							</div>
						)}
						<div>
							<dt>Observed by</dt>
							<dd>
								<ul className="hosted-observers">
									{task.sources.map((s) => (
										<li key={s.machineId}>
											{machines.get(s.machineId)?.name ?? s.machineId}{" "}
											<span>· {sourceStatus(s.state)}</span>
										</li>
									))}
								</ul>
							</dd>
						</div>
					</dl>
					{href && (
						<a
							className="hosted-button"
							href={href}
							target="_blank"
							rel="noopener noreferrer"
						>
							Open in {providers[task.provider].name}
							<ArrowUpRightIcon aria-hidden="true" />
						</a>
					)}
					{hasOpened && (
						<HostedTaskDetail
							provider={task.provider}
							id={task.id}
							listedUrl={href}
							sources={canWrite ? origins : []}
							onAccepted={refresh}
						/>
					)}
				</div>
			</details>
		</li>
	);
}

function ProviderSources({
	observations,
	machines,
}: {
	observations: HostedReport["providers"];
	machines: Map<string, Machine>;
}) {
	return (
		<details className="hosted-connections">
			<summary>
				Connections{" "}
				<ChevronDownIcon className="hosted-chevron" aria-hidden="true" />
			</summary>
			<ul>
				{[...machines.values()].map((m) => {
					const o = observations.find(
						(observation) => observation.machineId === m.machineId,
					);
					const label =
						m.state === "offline"
							? "Machine offline"
							: m.state !== "reachable"
								? "Hosted status unavailable"
								: o?.state === "ready"
									? "Connected"
									: o?.state === "stale"
										? "Showing last available results"
										: o?.detail === "not-configured"
											? "Connection not set up"
											: o?.detail === "read-failed"
												? "Could not read tasks"
												: "No provider status";
					return (
						<li key={m.machineId}>
							<strong>{m.name}</strong>
							<span>{label}</span>
							{o?.observedAt != null && (
								<small>Last successful read {timestamp(o.observedAt)}</small>
							)}
						</li>
					);
				})}
				{!machines.size && <li>No machines reported hosted status.</li>}
			</ul>
		</details>
	);
}

export function HostedView() {
	const [filter, setFilter] = useState<HostedProvider | "all">("all");
	const [search, setSearch] = useState("");
	const forceRefresh = useRef(false);
	const query = useQuery(
		{
			queryKey: ["hosted"],
			queryFn: ({ signal }) => {
				const path = forceRefresh.current ? "/hosted?refresh=1" : "/hosted";
				forceRefresh.current = false;
				return request<HostedReport>(path, { signal });
			},
			refetchInterval: 30_000,
			retry: false,
		},
		queryClient,
	);
	const report = query.data;
	const refresh = () => {
		void query.refetch();
	};
	const machines = new Map(report?.machines.map((m) => [m.machineId, m]));
	const canWrite = !!report && !query.isError;
	const needle = search.trim().toLowerCase();
	return (
		<div className="hosted-view">
			<div className="hosted-toolbar">
				<label className="hosted-search">
					<SearchIcon aria-hidden="true" />
					<input
						type="search"
						aria-label="Search hosted tasks"
						placeholder="Search tasks"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</label>
				<select
					aria-label="Filter by provider"
					value={filter}
					onChange={(event) => setFilter(event.target.value as typeof filter)}
				>
					<option value="all">All providers</option>
					{providerIds.map((id) => (
						<option key={id} value={id}>
							{providers[id].name}
						</option>
					))}
				</select>
				<button
					className="hosted-button"
					type="button"
					onClick={() => {
						forceRefresh.current = true;
						refresh();
					}}
					disabled={query.isFetching}
				>
					<RefreshCwIcon aria-hidden="true" />{" "}
					{query.isFetching ? "Refreshing…" : "Refresh"}
				</button>
			</div>
			{query.isPending && (
				<p className="hosted-notice" role="status">
					Loading hosted agents…
				</p>
			)}
			{query.isError && (
				<p className="hosted-notice" data-tone="issue" role="status">
					{report
						? "Could not refresh hosted agents. Showing the last results. Task actions are paused until a refresh succeeds."
						: "Could not load hosted agents. Use Refresh to try again."}
				</p>
			)}
			{report &&
				providerIds.map((provider) => {
					const items = report.tasks.filter(
						(task) => task.provider === provider,
					);
					const observations = report.providers.filter(
						(o) => o.provider === provider,
					);
					const available = observations.flatMap((o) => {
						const machine = machines.get(o.machineId);
						return machine?.state === "reachable" && o.state === "ready"
							? [machine]
							: [];
					});
					const matching = new Set(
						items
							.filter((task) =>
								[
									task.title,
									taskStatus(task.status),
									task.context,
									task.id,
								].some((value) => value?.toLowerCase().includes(needle)),
							)
							.map((task) => task.id),
					);
					const stale = observations.some((o) => o.state === "stale");
					return (
						<section
							className="hosted-provider"
							key={provider}
							hidden={filter !== "all" && filter !== provider}
							aria-label={providers[provider].name}
						>
							<header>
								<CloudIcon aria-hidden="true" />
								<div>
									<h2>{providers[provider].name}</h2>
									<p>
										{canWrite && available.length
											? `${available.length} connected`
											: stale || items.length
												? "Last known results"
												: "No live connection"}{" "}
										· {items.length} {items.length === 1 ? "task" : "tasks"}
									</p>
								</div>
							</header>
							<HostedAction
								provider={provider}
								machines={canWrite ? available : []}
								onAccepted={refresh}
							/>
							<ul className="hosted-task-list">
								{items.map((task) => (
									<TaskRow
										key={task.id}
										task={task}
										machines={machines}
										available={available}
										refresh={refresh}
										hidden={!matching.has(task.id)}
										canWrite={canWrite}
									/>
								))}
							</ul>
							{!matching.size && (
								<p className="hosted-empty">
									{items.length
										? "No tasks match your search."
										: available.length
											? "No recent tasks."
											: "No task list available."}
								</p>
							)}
							<ProviderSources
								observations={observations}
								machines={machines}
							/>
						</section>
					);
				})}
		</div>
	);
}
