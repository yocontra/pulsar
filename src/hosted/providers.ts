import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { exec } from "../exec.ts";
import {
	type HostedProvider,
	type HostedTask,
	type HostedWrite,
	type HostedWriteReceipt,
	hostedId,
} from "./wire.ts";

const TIMEOUT = 8_000;
const MAX_BODY = 512 * 1024;
const FIELDS = "id,name,state,repository,pullRequestUrl,updatedAt";

type Data = Record<string, unknown>;
type Result =
	| { state: "ready"; tasks: HostedTask[] }
	| { state: "unavailable"; detail: "not-configured" | "read-failed" };

const object = (v: unknown): Data | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Data) : null;

const str = (v: unknown, max = 500): string | null =>
	typeof v === "string"
		? v
				.replace(/\p{Cc}/gu, " ")
				.trim()
				.slice(0, max) || null
		: null;

function safeUrl(v: unknown, host: string, prefix: string): string | null {
	if (typeof v !== "string" || v.length > 2048) return null;
	try {
		const u = new URL(v);
		if (
			u.origin !== `https://${host}` ||
			u.username ||
			u.password ||
			!u.pathname.startsWith(prefix)
		)
			return null;
		return `${u.origin}${u.pathname}`;
	} catch {
		return null;
	}
}

async function which(cmd: string) {
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const file = resolve(dir, cmd);
		if (
			await access(file, constants.X_OK)
				.then(() => stat(file))
				.then(
					(info) => info.isFile(),
					() => false,
				)
		)
			return file;
	}
	return null;
}

async function cliEnvironment(): Promise<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GH_PROMPT_DISABLED: "1",
		NO_COLOR: "1",
		...(platform() === "darwin" &&
		!process.env.SSL_CERT_FILE &&
		(await access("/etc/ssl/cert.pem", constants.R_OK).then(
			() => true,
			() => false,
		))
			? { SSL_CERT_FILE: "/etc/ssl/cert.pem" }
			: {}),
	};
	delete env.CURSOR_API_KEY;
	return env;
}

async function runCli(bin: string, args: string[], stdin?: string) {
	// Codex Cloud can write account metadata to error.log in its working directory.
	const cwd = await mkdtemp(join(tmpdir(), "pulsar-hosted-"));
	try {
		return await exec(bin, args, {
			cwd,
			env: await cliEnvironment(),
			timeoutMs: stdin === undefined ? TIMEOUT : 30_000,
			maxBuffer: MAX_BODY,
			...(stdin === undefined ? {} : { stdin }),
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

class CursorHttpError extends Error {
	readonly status: number;

	constructor(status: number) {
		super("Cursor request failed");
		this.status = status;
	}
}

// These responses reject the operation before creating an agent or run.
const CURSOR_REJECTION_CODES = new Set([400, 401, 403, 404, 409, 422, 429]);

async function readCursor(
	path: string,
	key: string,
	body?: object,
): Promise<unknown> {
	const response = await fetch(`https://api.cursor.com/v1/agents${path}`, {
		headers: {
			Authorization: `Bearer ${key}`,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(TIMEOUT),
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new CursorHttpError(response.status);
	}
	if (!response.body) throw new Error("Cursor response is empty");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_BODY) throw new Error("Cursor response exceeded limit");
			text += decoder.decode(value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} finally {
		await reader.cancel();
	}
}

type WriteFor<P extends HostedProvider> = Extract<HostedWrite, { provider: P }>;
interface TaskNormalization {
	updatedAt: string;
	normalize(row: Data, id: string): Omit<HostedTask, "id" | "updatedAt">;
}

interface ProviderDefinition<P extends HostedProvider>
	extends TaskNormalization {
	credential(): string | null | Promise<string | null>;
	list(credential: string): Promise<unknown>;
	listItems(value: unknown): unknown;
	view(
		this: TaskNormalization,
		credential: string,
		id: string,
	): Promise<HostedTask | string | null>;
	write(
		credential: string,
		write: WriteFor<P>,
	): Promise<HostedWriteReceipt | null>;
}

type Registration = ProviderDefinition<HostedProvider>;

function matchesProvider<P extends HostedProvider>(
	write: HostedWrite,
	provider: P,
): write is WriteFor<P> {
	return write.provider === provider;
}

function register<P extends HostedProvider>(
	provider: P,
	definition: ProviderDefinition<P>,
): Registration {
	return {
		...definition,
		async write(credential, write) {
			if (!matchesProvider(write, provider))
				throw new Error("wrong hosted provider");
			return definition.write(credential, write);
		},
	};
}

async function cliOutput(bin: string, args: string[]): Promise<string> {
	const result = await runCli(bin, args);
	if (!result.ok) throw new Error("Hosted command failed");
	return result.stdout;
}

function codexUrl(value: unknown) {
	const url = safeUrl(value, "chatgpt.com", "/codex/");
	if (
		!url ||
		!/^https:\/\/chatgpt\.com\/codex\/(?:cloud\/)?tasks\/[\w.:-]+$/.test(url)
	)
		return undefined;
	return url.replace("/codex/tasks/", "/codex/cloud/tasks/");
}

const providers = {
	copilot: register("copilot", {
		credential: () => which("gh"),
		async list(bin) {
			return JSON.parse(
				await cliOutput(bin, [
					"agent-task",
					"list",
					"-L",
					"20",
					"--json",
					FIELDS,
				]),
			);
		},
		listItems: (value) => value,
		updatedAt: "updatedAt",
		normalize(row, id) {
			const pr = safeUrl(row.pullRequestUrl, "github.com", "/");
			return {
				title: str(row.name) ?? id,
				status: str(row.state, 80) ?? "Unknown",
				context: str(row.repository),
				url:
					pr && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr)
						? `${pr}/agent-sessions/${encodeURIComponent(id)}`
						: null,
			};
		},
		async view(bin, id) {
			const output = await cliOutput(bin, [
				"agent-task",
				"view",
				id,
				"--json",
				FIELDS,
			]);
			return normalize(this, JSON.parse(output));
		},
		async write(bin, write) {
			const args = [
				"agent-task",
				"create",
				"-R",
				`github.com/${write.repo}`,
				"-F",
				"-",
				...(write.ref ? ["--base", write.ref] : []),
			];
			const result = await runCli(bin, args, write.prompt);
			if (!result.ok) return null;
			for (const line of result.stdout.trim().split("\n")) {
				const url = safeUrl(line, "github.com", "/");
				const id = url?.split("/").at(-1);
				if (
					url &&
					id &&
					hostedId.safeParse(id).success &&
					new URL(url).pathname
						.toLowerCase()
						.startsWith(`/${write.repo.toLowerCase()}/pull/`) &&
					/\/pull\/\d+\/agent-sessions\/[^/]+$/.test(url)
				)
					return { state: "accepted", id, url };
			}
			const job = /^job ([\w-]+) queued\./m.exec(result.stdout);
			return job ? { state: "accepted", id: null } : null;
		},
	}),
	codex: register("codex", {
		credential: () => which("codex"),
		async list(bin) {
			return JSON.parse(
				await cliOutput(bin, ["cloud", "list", "--limit", "20", "--json"]),
			);
		},
		listItems: (value) => object(value)?.tasks,
		updatedAt: "updated_at",
		normalize(row, id) {
			return {
				title: str(row.title) ?? id,
				status: str(row.status, 80) ?? "Unknown",
				context: str(row.environment_label),
				url: codexUrl(row.url) ?? null,
			};
		},
		async view(bin, id) {
			return (await cliOutput(bin, ["cloud", "status", id])).trim();
		},
		async write(bin, write) {
			const result = await runCli(
				bin,
				[
					"cloud",
					"exec",
					"--env",
					write.environment,
					"--branch",
					write.ref,
					"-",
				],
				write.prompt,
			);
			if (!result.ok) return null;
			const url = codexUrl(result.stdout.trim());
			const id = url?.split("/").at(-1);
			return url && id && hostedId.safeParse(id).success
				? { state: "accepted", id, url }
				: null;
		},
	}),
	cursor: register("cursor", {
		credential: () => process.env.CURSOR_API_KEY ?? null,
		list: (key) => readCursor("?limit=20", key),
		listItems: (value) => object(value)?.items,
		updatedAt: "updatedAt",
		normalize(row, id) {
			return {
				title: str(row.name) ?? id,
				status: str(row.status, 80) ?? "Unknown",
				context: null,
				url: safeUrl(row.url, "cursor.com", "/agents/"),
			};
		},
		async view(key, id) {
			return normalize(
				this,
				await readCursor(`/${encodeURIComponent(id)}`, key),
			);
		},
		async write(key, write) {
			const prompt = { text: write.prompt };
			let value: unknown;
			try {
				value =
					write.action === "create"
						? await readCursor("", key, {
								prompt,
								repos: [
									{
										url: `https://github.com/${write.repo}`,
										startingRef: write.ref,
									},
								],
								autoCreatePR: false,
							})
						: await readCursor(`/${encodeURIComponent(write.id)}/runs`, key, {
								prompt,
							});
			} catch (error) {
				if (
					error instanceof CursorHttpError &&
					CURSOR_REJECTION_CODES.has(error.status)
				)
					return { state: "rejected", status: error.status };
				throw error;
			}
			const response = object(value);
			const agent = object(response?.agent);
			const run = object(response?.run);
			const id = hostedId.safeParse(
				write.action === "create" ? agent?.id : write.id,
			);
			const runId = hostedId.safeParse(run?.id);
			const url = safeUrl(agent?.url, "cursor.com", "/agents/");
			return id.success && runId.success && run?.agentId === id.data
				? {
						state: "accepted",
						id: id.data,
						runId: runId.data,
						...(url ? { url } : {}),
					}
				: null;
		},
	}),
} satisfies Record<HostedProvider, Registration>;

function normalize(
	registration: TaskNormalization,
	value: unknown,
): HostedTask | null {
	const row = object(value);
	const id = hostedId.safeParse(row?.id);
	if (!row || !id.success) return null;
	const updated = row[registration.updatedAt];
	const timestamp = typeof updated === "string" ? Date.parse(updated) : NaN;
	return {
		id: id.data,
		updatedAt: Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null,
		...registration.normalize(row, id.data),
	};
}

export function decodeHosted(
	provider: HostedProvider,
	value: unknown,
): HostedTask[] | null {
	const registration = providers[provider];
	const rows = registration.listItems(value);
	if (!Array.isArray(rows)) return null;
	const tasks: HostedTask[] = [];
	for (const row of rows.slice(0, 30)) {
		const task = normalize(registration, row);
		if (!task) return null;
		tasks.push(task);
	}
	return tasks;
}

export async function readHosted(provider: HostedProvider): Promise<Result> {
	const registration = providers[provider];
	const credential = await registration.credential();
	if (!credential) return { state: "unavailable", detail: "not-configured" };
	try {
		const tasks = decodeHosted(provider, await registration.list(credential));
		if (tasks) return { state: "ready", tasks };
	} catch {
		// Provider errors can include local paths, credentials or response bodies.
	}
	return { state: "unavailable", detail: "read-failed" };
}

export async function viewHosted(
	provider: HostedProvider,
	id: string,
): Promise<HostedTask | string | null> {
	if (!hostedId.safeParse(id).success) return null;
	try {
		const registration = providers[provider];
		const credential = await registration.credential();
		return credential ? await registration.view(credential, id) : null;
	} catch {
		return null;
	}
}

export async function hostedWriter(provider: HostedProvider) {
	const registration = providers[provider];
	const credential = await registration.credential();
	return credential
		? (write: HostedWrite) => registration.write(credential, write)
		: null;
}
