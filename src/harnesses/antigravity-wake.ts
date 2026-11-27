import { access } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { DaemonClient } from "../client.ts";
import { exec } from "../exec.ts";
import { pidAlive, processStart, processTable } from "../processes.ts";
import { PROTOCOL_VERSION, type Registration } from "../types.ts";
import { antigravityChildOf } from "./antigravity-children.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	antigravityConversations,
	antigravityProcess,
	nativeAntigravityProcess,
} from "./antigravity-ident.ts";
import { findHarnessAncestor } from "./ident.ts";

export type NativeBinding = {
	pid: number;
	birth: string;
	sessionId: string;
	rootSessionId?: string;
	cwd: string;
};

export async function antigravityBinding(
	sessionId: string,
): Promise<NativeBinding | null> {
	if (
		!ANTIGRAVITY_SESSION_ID.test(sessionId) ||
		(process.env.ANTIGRAVITY_CONVERSATION_ID &&
			process.env.ANTIGRAVITY_CONVERSATION_ID !== sessionId)
	)
		return null;
	const table = await processTable();
	const ancestor = await findHarnessAncestor(process.pid, table);
	const supplied = sessionId;
	const hosts = [...table.values()].filter(
		(p) =>
			nativeAntigravityProcess(p.args) &&
			(ancestor?.harness === "antigravity"
				? p.pid === ancestor.pid
				: process.env.ANTIGRAVITY_CONVERSATION_ID === supplied),
	);
	const matches = (
		await Promise.all(
			hosts.map(async ({ pid }) => {
				const [{ sessionId, cwd }, birth] = await Promise.all([
					antigravityProcess(pid),
					processStart(pid),
				]);
				if (!sessionId || !cwd || !birth) return null;
				if (sessionId === supplied) return { pid, birth, sessionId, cwd };
				if (
					!antigravityChildOf(antigravityConversations(), sessionId, supplied)
				)
					return null;
				return {
					pid,
					birth,
					sessionId: supplied,
					rootSessionId: sessionId,
					cwd,
				};
			}),
		)
	).filter((b) => b !== null);
	return matches.length === 1 ? matches[0]! : null;
}

/** The host supplies agentapi and its credentials. They stay in this process tree. */
async function antigravityAgentApi(args: string[]) {
	const binary = process.env.ANTIGRAVITY_AGENTAPI_EXE;
	const native = binary && isAbsolute(binary);
	const installed = join(
		dirname(antigravityConversations()),
		"bin",
		"agentapi",
	);
	const command = native
		? binary
		: await access(installed).then(
				() => installed,
				() => "agentapi",
			);
	const result = await exec(command, native ? ["agentapi", ...args] : args, {
		timeoutMs: 8000,
		maxBuffer: 512 * 1024,
		lane: "user",
	});
	if (!result.ok) return false;
	try {
		const reply = JSON.parse(result.stdout);
		if (reply?.error) return false;
		if (args[0] === "send-message")
			return reply?.response?.sendMessage?.recipientId === args[1];
		const metadata = reply?.response?.conversationMetadata?.metadata;
		return (
			!!metadata &&
			typeof metadata === "object" &&
			!Array.isArray(metadata) &&
			Object.keys(metadata).length > 0 &&
			(metadata.conversationId === undefined ||
				metadata.conversationId === args[1])
		);
	} catch {
		return false;
	}
}

/** Register only after the vendor client can read this exact conversation. */
async function connectAntigravityRelay(
	client: DaemonClient,
	b: NativeBinding,
	current: () => Promise<boolean>,
) {
	if (
		!(await current()) ||
		!(await antigravityAgentApi(["get-conversation-metadata", b.sessionId]))
	)
		throw new Error("Antigravity could not verify this native conversation.");
	await client.connect(true);
	try {
		const reg: Registration = {
			harness: "antigravity",
			role: "wake",
			capabilities: ["wake-children"],
			pid: b.pid,
			sessionId: b.sessionId,
			cwd: b.cwd,
			project: null,
			branch: null,
			tags: [],
		};
		const reply = await client.call<{ nativeWake?: boolean }>("hello", {
			protocol: PROTOCOL_VERSION,
			registration: reg,
		});
		if (!reply.nativeWake)
			throw new Error("Update the Pulsar daemon to enable native wake.");
	} catch (error) {
		client.close();
		throw error;
	}
}

function handleAntigravityWake(
	client: DaemonClient,
	sessionId: string,
	current: () => Promise<boolean>,
) {
	// A daemon reconnect can replay a queued request whose vendor acknowledgement
	// arrived after the socket closed. Keep successful attempts in this relay.
	const attempts = new Map<string, Promise<boolean>>();
	client.on("wake", async (event) => {
		const req = event as {
			requestId: string;
			messageId: string;
			attempt: number;
			sessionId: string;
			text: string;
		};
		let ok = false;
		if (
			typeof req.sessionId === "string" &&
			typeof req.text === "string" &&
			(req.sessionId === sessionId ||
				antigravityChildOf(
					antigravityConversations(),
					sessionId,
					req.sessionId,
				))
		) {
			const key = JSON.stringify([req.sessionId, req.messageId, req.attempt]);
			let send = attempts.get(key);
			if (!send) {
				send = current()
					.then(
						(valid) =>
							valid &&
							antigravityAgentApi(["send-message", req.sessionId, req.text]),
					)
					.catch(() => false);
				attempts.set(key, send);
			}
			ok = await send;
			if (!ok) attempts.delete(key);
			if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!);
		}
		await client
			.call("wake_result", { requestId: req.requestId, ok })
			.catch(() => {});
	});
}

export async function serveAntigravityWake(b: NativeBinding) {
	const client = new DaemonClient();
	const state = async () => {
		if (!pidAlive(b.pid)) return "gone";
		const birth = await processStart(b.pid);
		if (!birth) return "unavailable";
		if (birth !== b.birth) return "gone";
		const { sessionId } = await antigravityProcess(b.pid);
		if (!sessionId) return "unavailable";
		return sessionId === b.sessionId ? "active" : "gone";
	};
	const current = async () => (await state()) === "active";
	handleAntigravityWake(client, b.sessionId, current);
	const connect = () => connectAntigravityRelay(client, b, current);
	await connect();
	// The relay lives exactly as long as this conversation and reconnects after daemon upgrades.
	let checking = false;
	setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			const status = await state();
			if (status === "gone") process.exit(0);
			if (status === "unavailable") client.close();
			else if (!client.connected) await connect();
		} catch (error) {
			if ((error as { code?: string }).code === "native_wake_bound")
				process.exit(0);
		} finally {
			checking = false;
		}
	}, 10_000);
}
