import { stripVTControlCharacters } from "node:util";
import { viewHosted } from "./providers.ts";
import type { HostedProvider, HostedTaskDetail } from "./wire.ts";
import { hostedTaskDetail } from "./wire.ts";

interface Source {
	provider: HostedProvider;
	id: string;
	machineId: string;
}

function clean(value: string, multiline = false): string {
	return stripVTControlCharacters(value)
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (c) =>
			multiline && (c === "\n" || c === "\t") ? c : " ",
		)
		.trim();
}

function taskLink(
	provider: HostedProvider,
	id: string,
	link: string | null,
): string | null {
	if (!link) return null;
	try {
		const url = new URL(link);
		if (url.username || url.password || url.protocol !== "https:" || url.port)
			return null;
		if (decodeURIComponent(url.pathname.split("/").at(-1) ?? "") !== id)
			return null;
		const allowed =
			provider === "cursor"
				? url.hostname === "cursor.com" &&
					/^\/agents\/[^/]+$/.test(url.pathname)
				: provider === "copilot" &&
					url.hostname === "github.com" &&
					/^\/[\w.-]+\/[\w.-]+\/pull\/\d+\/agent-sessions\/[^/]+$/.test(
						url.pathname,
					);
		return allowed ? `${url.origin}${url.pathname}` : null;
	} catch {
		return null;
	}
}

export function unavailableHostedDetail(
	source: Source,
	reason: "source-unreachable" | "read-failed",
): HostedTaskDetail {
	return { ...source, state: "unavailable", reason };
}

/** The relay may only return the detail that the operator requested. */
export function cleanHostedDetail(
	source: Source,
	value: unknown,
): HostedTaskDetail {
	const parsed = hostedTaskDetail.safeParse(value);
	if (!parsed.success) return unavailableHostedDetail(source, "read-failed");
	const result = parsed.data;
	if (
		result.provider !== source.provider ||
		result.id !== source.id ||
		result.machineId !== source.machineId
	)
		return unavailableHostedDetail(source, "read-failed");
	if (result.state === "unavailable") return result;
	if (result.detail.kind === "text") {
		const text = clean(result.detail.text, true);
		return source.provider === "codex" && text
			? { ...result, detail: { kind: "text", text } }
			: unavailableHostedDetail(source, "read-failed");
	}
	const task = result.detail.task;
	if (source.provider === "codex" || task.id !== source.id)
		return unavailableHostedDetail(source, "read-failed");
	return {
		...result,
		detail: {
			kind: "task",
			task: {
				...task,
				title: clean(task.title) || task.id,
				status: clean(task.status) || "Unknown",
				context: task.context ? clean(task.context) || null : null,
				url: taskLink(source.provider, task.id, task.url),
			},
		},
	};
}

export async function viewHostedDetail(
	source: Source,
	read = viewHosted,
): Promise<HostedTaskDetail> {
	try {
		const value = await read(source.provider, source.id);
		if (value === null) return unavailableHostedDetail(source, "read-failed");
		const detail =
			typeof value === "string"
				? { kind: "text", text: clean(value, true).slice(0, 32_000) }
				: { kind: "task", task: value };
		return cleanHostedDetail(source, { ...source, state: "ready", detail });
	} catch {
		return unavailableHostedDetail(source, "read-failed");
	}
}
