import { useQuery } from "@tanstack/react-query";
import type {
	HostedProvider,
	HostedReport,
} from "../../../../src/hosted/wire.ts";
import { request } from "../../api/client.ts";
import { queryClient } from "../../data/hooks.ts";
import { HostedAction } from "./HostedAction.tsx";
import "./hosted.css";

const providers: Record<HostedProvider, { name: string; origin: string }> = {
	copilot: { name: "GitHub Copilot", origin: "https://github.com" },
	codex: { name: "Codex Cloud", origin: "https://chatgpt.com" },
	cursor: { name: "Cursor Cloud", origin: "https://cursor.com" },
};

function taskUrl(url: string | null, origin: string): string | undefined {
	if (!url) return;
	try {
		const u = new URL(url);
		if (u.origin === origin && !u.username && !u.password)
			return `${u.origin}${u.pathname}`;
	} catch {
		// Ignore unrecognized links supplied by the provider or a peer.
	}
}

export function HostedView() {
	const query = useQuery(
		{
			queryKey: ["hosted"],
			queryFn: ({ signal }) => request<HostedReport>("/hosted", { signal }),
			refetchInterval: 30_000,
			retry: false,
		},
		queryClient,
	);
	const report = query.data;
	if (!report)
		return (
			<p className="hosted-view" role="status">
				{query.isPending
					? "Loading hosted agents…"
					: "Could not load hosted agents."}
			</p>
		);
	const machines = new Map(report.machines.map((m) => [m.machineId, m]));
	return (
		<div className="hosted-view">
			{query.isError ? (
				<p role="status">
					Could not refresh hosted agents. Showing the last results.
				</p>
			) : null}
			{report.machines
				.filter((m) => m.state !== "reachable")
				.map((m) => (
					<p key={m.machineId}>
						{m.name} ·{" "}
						{m.state === "offline" ? "Offline" : "Hosted status unavailable"}
					</p>
				))}
			{Object.entries(providers).map(([provider, display]) => {
				const items = report.tasks.filter((task) => task.provider === provider);
				const observations = report.providers.filter(
					(o) => o.provider === provider,
				);
				const available = observations.flatMap((o) => {
					const machine = machines.get(o.machineId);
					return machine?.state === "reachable" && o.state === "ready"
						? [machine]
						: [];
				});
				const refresh = () => {
					void query.refetch();
				};
				return (
					<section key={provider}>
						<h2>{display.name}</h2>
						<HostedAction
							provider={provider as HostedProvider}
							machines={available}
							onAccepted={refresh}
						/>
						{items.length ? (
							<ul>
								{items.map((task) => {
									const href = taskUrl(task.url, display.origin);
									return (
										<li key={task.id}>
											<div className="hosted-task-title">
												{href ? (
													<a
														href={href}
														target="_blank"
														rel="noopener noreferrer"
													>
														{task.title}
													</a>
												) : (
													task.title
												)}
											</div>
											<div>
												{[task.status, task.context]
													.filter(Boolean)
													.join(" · ")}
											</div>
											<small>
												{task.sources
													.map((s) => {
														const label =
															machines.get(s.machineId)?.name ?? s.machineId;
														return s.state === "reachable"
															? label
															: `${label} (${s.state})`;
													})
													.join(", ")}
											</small>
											{provider === "cursor" && task.status === "IDLE" && (
												<HostedAction
													provider="cursor"
													id={task.id}
													onAccepted={refresh}
													machines={available.filter((m) =>
														task.sources.some(
															(s) =>
																s.machineId === m.machineId &&
																s.state === "reachable",
														),
													)}
												/>
											)}
										</li>
									);
								})}
							</ul>
						) : (
							<p>
								{observations.some(
									(o) =>
										o.state === "ready" &&
										machines.get(o.machineId)?.state === "reachable",
								)
									? "No recent tasks."
									: "No current task list."}
							</p>
						)}
						{observations
							.filter(
								(o) =>
									o.state !== "ready" &&
									machines.get(o.machineId)?.state === "reachable",
							)
							.map((o) => (
								<p key={o.machineId}>
									{machines.get(o.machineId)?.name} ·{" "}
									{o.state === "stale"
										? "Showing last available results"
										: o.detail === "not-configured"
											? "Connection not set up"
											: "Could not read tasks"}
								</p>
							))}
					</section>
				);
			})}
		</div>
	);
}
