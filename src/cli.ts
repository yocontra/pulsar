#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { DaemonClient } from "./client.ts";
import type { AskResponse, StopResult } from "./http/wire.ts";
import { neutralizeHumanTag } from "./human-tag.ts";
import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
} from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";
import { VERSION } from "./version.ts";

const HELP = `Pulsar ${VERSION} — find and message AI agents across every harness on this machine

Usage:
  pulsar setup [--yes] [--all-detected] [--client <name>]... [--dry-run] [--no-mcp] [--skills-dir <path>] [--no-approvals] [--mesh] [--uninstall]
                                  configure detected harnesses and install session integrations
                                  asks whether to turn on the agent mesh (--mesh: turn it on without asking)
  pulsar acp --list                 list installed ACP executables and catalog entries
  pulsar acp <provider> [--resume <session-id>]   start or resume a managed ACP session
  pulsar hosted <provider> [list|view <id>]        read hosted tasks through this machine
  pulsar ls [selector]            list live agents (selector: name, project=x, harness=codex, tag, *)
  pulsar send <to> <message...>   send as "operator" (to: name, selector, or '*')
        [--priority urgent|normal|fyi] [--expect-reply] [--await-reply [--timeout s]]
                                  (--await-reply: wait for the first reply and print it)
  pulsar reply <id> <message...>  answer a message in its thread
  pulsar inbox                    read replies sent to you (operator)
  pulsar tail                     stream agents joining/leaving and every message
  pulsar interrupt <agent>        stop an agent's current turn (its session keeps running)
  pulsar ask <question...>        who works on a file, PR, branch or project; wakes nobody
        [--selector s] [--direct]   (--direct: then ask the top matches and wait for a reply)
  pulsar qr                       QR code of the app's URL, for opening it on your phone
                                  (offers to turn the agent mesh on when it is off)
  pulsar ui                       open the app in your browser
  pulsar mesh [status]            the agent mesh (off until you turn it on): app URL, linked machines
  pulsar mesh on|off              turn it on (Tailscale, HTTPS certificate, app, background service,
                                  Claude Code approvals) or off; \`pulsar mesh help\` for options
  pulsar mesh list|allow|deny|forget|owner [node|login]
                                  which tagged nodes may join the pool (your own nodes join on their own);
                                  a change waits for you to confirm it (Touch ID, or your passkey in the app)
  pulsar passkeys [remove <id>]   devices that proved you're human in the app (Prove Human);
                                  remove waits for you to confirm it, like mesh changes
  pulsar doctor [--mesh] [--json] check the daemon, each harness and the agent mesh (--mesh: mesh only, read-only; --json: one JSON line)
  pulsar status                   daemon status
  pulsar stop                     stop the daemon (it restarts on next use; not the background service)
  pulsar mcp                      run the MCP server (your agent's config runs this)
  pulsar daemon [--service]       run the daemon in the foreground
                                  (--service: launchd/systemd own it; no idle exit, stop refused)

https://github.com/yocontra/pulsar`;

// Loaded on use: `pulsar hook` runs on every permission prompt and must start fast.
const loadClient = async () => (await import("./client.ts")).DaemonClient;
const loadFormat = () => import("./format.ts");

async function operatorClient(autoStart = true) {
	const client = new (await loadClient())();
	await client.connect(autoStart);
	await sayHello(client);
	return client;
}

/** Run from a terminal, this is the operator. Run from an agent's shell, it is that agent. */
async function sayHello(client: DaemonClient) {
	const { detectRegistration } = await import("./identity.ts");
	const registration = await detectRegistration("cli");
	await client.call("hello", {
		protocol: PROTOCOL_VERSION,
		version: VERSION,
		registration,
	});
	if (registration.meta?.acp !== "1") {
		const { identFor } = await import("./harnesses/ident.ts");
		await identFor(registration.harness)
			?.onSessionReady?.(registration)
			.catch(() => {});
	}
}

/** Connects to a running daemon without starting one; null when none is running. */
async function runningClient(): Promise<DaemonClient | null> {
	const client = new (await loadClient())();
	try {
		await client.connect(false);
	} catch {
		return null;
	}
	return client;
}

function fail(message: string): never {
	process.stderr.write(`pulsar: ${message}\n`);
	process.exit(1);
}

async function main(argv: string[]) {
	const [command, ...rest] = argv;
	switch (command) {
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(HELP);
			return;
		case "hosted": {
			const { hostedCommand } = await import("./hosted/cli.ts");
			process.exitCode = await hostedCommand(rest);
			return;
		}
		case "acp": {
			const { ACP_PROVIDERS } = await import("./harnesses/acp-catalog.ts");
			if (rest.length === 1 && rest[0] === "--list") {
				const { which } = await import("./setup/files.ts");
				for (const p of ACP_PROVIDERS)
					console.log(
						`${p.id}\t${p.label}\t${which(p.binary) ?? `Install ${p.binary}`}`,
					);
				return;
			}
			const provider = ACP_PROVIDERS.find((p) => p.id === rest[0]);
			if (
				!provider ||
				(rest.length !== 1 &&
					!(rest.length === 3 && rest[1] === "--resume" && rest[2]))
			)
				fail(
					`usage: pulsar acp <${ACP_PROVIDERS.map((p) => p.id).join("|")}> [--resume <session-id>]`,
				);
			const { runAcpBridge } = await import("./harnesses/acp.ts");
			await runAcpBridge({
				command: [provider.binary, ...provider.args],
				...("env" in provider ? { env: provider.env } : {}),
				harness: provider.id,
				cwd: process.cwd(),
				sessionId: rest[2],
			});
			return;
		}
		case "--version":
		case "-v":
		case "version":
			console.log(VERSION);
			return;
		case "hook": {
			const { runHook } = await import("./hook.ts");
			await runHook(rest[0], rest.slice(1));
			return;
		}
		case "passkeys": {
			const { passkeysCommand } = await import("./passkeys-cli.ts");
			const client = await operatorClient();
			try {
				process.exitCode = await passkeysCommand(client, rest);
			} finally {
				client.close();
			}
			return;
		}
		case "worker": {
			if (rest.length !== 1 || rest[0] !== "native-wake" || !process.send)
				throw new Error("This worker requires a Pulsar session connection.");
			const { runNativeWakeWorker } = await import("./native-wake.ts");
			await runNativeWakeWorker();
			return;
		}
		case "mcp": {
			const { runMcp } = await import("./mcp.ts");
			await runMcp();
			return;
		}
		case "daemon": {
			const { values } = parseArgs({
				args: rest,
				options: { service: { type: "boolean" } },
				// Older callers may pass other words; they were always ignored.
				strict: false,
			});
			const { runDaemon } = await import("./run-daemon.ts");
			await runDaemon({ service: values.service === true });
			return;
		}
		case "ls":
		case "list": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { json: { type: "boolean" }, all: { type: "boolean" } },
				allowPositionals: true,
			});
			const selector = positionals.join(" ") || "*";
			const client = await operatorClient();
			const agents = await client.call<PublicAgent[]>("list", {
				selector,
				includeGone: values.all,
			});
			const { agentsText } = await loadFormat();
			console.log(
				values.json
					? JSON.stringify(agents, null, 2)
					: agentsText(agents, selector),
			);
			client.close();
			return;
		}
		case "send": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					priority: { type: "string", short: "p" },
					"expect-reply": { type: "boolean" },
					"await-reply": { type: "boolean" },
					timeout: { type: "string" },
				},
				allowPositionals: true,
			});
			const [to, ...words] = positionals;
			if (!to || words.length === 0)
				fail("usage: pulsar send <to> <message...>");
			const awaitReply = values["await-reply"] ?? false;
			const timeout = Number(values.timeout ?? 120);
			if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800)
				fail("--timeout is whole seconds, 1 to 1800");
			const client = await operatorClient();
			try {
				const r = await client.call<{ message: Message; receipts: Receipt[] }>(
					"send",
					{
						to,
						body: words.join(" "),
						priority: values.priority ?? (awaitReply ? "urgent" : "normal"),
						expectReply: awaitReply || (values["expect-reply"] ?? false),
					},
				);
				const { receiptsText } = await loadFormat();
				console.log(
					`Sent ${r.message.id} to ${r.receipts.length} agent(s):\n${receiptsText(r.receipts)}`,
				);
				if (!awaitReply) return;
				const got = await client.call<{
					event: string;
					message?: DeliveredMessage;
				}>(
					"wait",
					{ for: `reply:${r.message.id}`, timeoutSeconds: timeout },
					(timeout + 10) * 1000,
				);
				console.log(
					got.event === "reply" && got.message
						? `Reply from ${got.message.from.name}:\n${got.message.body}`
						: got.event === "timeout"
							? `No reply within ${timeout}s; replies land in \`pulsar inbox\`.`
							: `${r.message.id}: ${got.event}`,
				);
			} finally {
				client.close();
			}
			return;
		}
		case "reply": {
			const [messageId, ...words] = rest;
			if (!messageId || words.length === 0)
				fail("usage: pulsar reply <message-id> <message...>");
			const client = await operatorClient();
			const r = await client.call<{ message: Message; receipts: Receipt[] }>(
				"reply",
				{
					messageId,
					body: words.join(" "),
				},
			);
			const { receiptsText } = await loadFormat();
			console.log(`Replied with ${r.message.id}:\n${receiptsText(r.receipts)}`);
			client.close();
			return;
		}
		case "inbox": {
			const client = await operatorClient();
			const r = await client.call<{ messages: DeliveredMessage[] }>("inbox", {
				markRead: true,
				limit: 100,
			});
			const { messageText } = await loadFormat();
			console.log(
				r.messages.length
					? r.messages.map(messageText).join("\n")
					: "No unread messages.",
			);
			client.close();
			return;
		}
		case "tail": {
			const client = await operatorClient();
			client.on("agent", (d) => {
				const { action, agent } = d as { action: string; agent: PublicAgent };
				console.log(
					`${new Date().toLocaleTimeString()}  ${action.padEnd(6)} ${agent.name} [${agent.harness}]${agent.project ? ` project=${agent.project}` : ""}`,
				);
			});
			client.on("message", (d) => {
				const { message, recipients } = d as {
					message: Message;
					recipients: string[];
				};
				console.log(
					`${new Date().toLocaleTimeString()}  msg    ${neutralizeHumanTag(message.fromName)} → ${message.to} (${recipients.join(", ")}): ${neutralizeHumanTag(message.body).replace(/\s+/g, " ").slice(0, 160)}`,
				);
			});
			await client.call("tail");
			console.log("Watching Pulsar traffic. Ctrl-C to stop.");
			client.onClose(() => process.exit(0));
			await new Promise(() => {});
			return;
		}
		case "ask": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					selector: { type: "string" },
					direct: { type: "boolean" },
				},
				allowPositionals: true,
			});
			const question = positionals.join(" ").trim();
			if (!question)
				fail(
					'usage: pulsar ask [--selector s] [--direct] "who is editing src/x.ts"',
				);
			const client = await operatorClient();
			try {
				const r = await client.call<AskResponse>("lookup", {
					question,
					...(values.selector ? { selector: values.selector } : {}),
				});
				const { askText } = await loadFormat();
				console.log(askText(r));
				if (!values.direct || !r.matches.length) return;
				const ids = r.matches.slice(0, 5).map((m) => m.agent.id);
				const sent = await client.call<{
					message: Message;
					receipts: Receipt[];
				}>("send", {
					to: `id=${ids.join("|")}`,
					body: question,
					priority: "normal",
					expectReply: true,
				});
				console.log(
					`\nAsked ${ids.length} agent(s) (${sent.message.id}); waiting up to 120s…`,
				);
				const got = await client.call<{
					event: string;
					message?: DeliveredMessage;
				}>(
					"wait",
					{ for: `reply:${sent.message.id}`, timeoutSeconds: 120 },
					130_000,
				);
				console.log(
					got.event === "reply" && got.message
						? `Reply from ${got.message.from.name}:\n${got.message.body}\n(others land in \`pulsar inbox\`)`
						: "No reply yet; replies land in `pulsar inbox`.",
				);
			} finally {
				client.close();
			}
			return;
		}
		case "interrupt": {
			const [agent] = rest;
			if (!agent) fail("usage: pulsar interrupt <agent name or id>");
			const client = await operatorClient();
			try {
				const r = await client.call<StopResult>("stop", { agent });
				const words: Record<StopResult["result"], string> = {
					interrupted: "interrupted",
					"not-running": "was not running a turn",
					unsupported: "can't be interrupted from here",
				};
				console.log(
					`${r.agentId} ${words[r.result]} (${r.via}${r.detail ? `: ${r.detail}` : ""})`,
				);
				if (r.result === "unsupported") process.exitCode = 1;
			} finally {
				client.close();
			}
			return;
		}
		case "status": {
			const client = await runningClient();
			if (!client) {
				console.log("daemon: not running (it starts on first use)");
				return;
			}
			try {
				await sayHello(client);
				console.log(JSON.stringify(await client.call("status"), null, 2));
			} finally {
				client.close();
			}
			return;
		}
		case "stop": {
			const client = await runningClient();
			if (!client) {
				console.log("daemon was not running");
				return;
			}
			try {
				// As the operator, never as the agent whose shell this is.
				await client.call("hello", {
					protocol: PROTOCOL_VERSION,
					version: VERSION,
					registration: { role: "cli" },
				});
				await client.call("shutdown");
			} finally {
				client.close();
			}
			console.log("daemon stopped");
			return;
		}
		case "qr": {
			const { appUrlOrReason, meshIsOn, MESH_OFF } = await import(
				"./http/config.ts"
			);
			if (!meshIsOn()) {
				if (!process.stdin.isTTY || !process.stdout.isTTY) fail(MESH_OFF);
				const { confirm } = await import("./setup/steps.ts");
				if (!(await confirm("The agent mesh is off. Turn it on now?")))
					fail("the agent mesh stays off; `pulsar mesh on` turns it on");
				// `mesh on` ends with the app's URL and QR code.
				const { meshOn } = await import("./setup/mesh-cli.ts");
				process.exitCode = await meshOn({
					yes: false,
					confirmed: true,
					approvals: true,
					prove: false,
				});
				return;
			}
			const r = await appUrlOrReason();
			if ("reason" in r) fail(r.reason);
			const { terminalQr } = await import("./setup/mesh.ts");
			console.log(`${await terminalQr(r.url)}\n${r.url}`);
			return;
		}
		case "ui": {
			const { appUrlOrReason } = await import("./http/config.ts");
			const r = await appUrlOrReason();
			if ("reason" in r) fail(r.reason);
			const { runCommand } = await import("./setup/service.ts");
			const opener =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "explorer"
						: "xdg-open";
			const opened = await runCommand(opener, [r.url]);
			console.log(opened.ok ? `Opened ${r.url}` : `Open ${r.url}`);
			return;
		}
		case "mesh": {
			const [verb, ...args] = rest;
			const mesh = await import("./setup/mesh-cli.ts");
			switch (verb) {
				case undefined:
				case "status": {
					const client = await runningClient();
					try {
						if (client) await sayHello(client);
						process.exitCode = await mesh.meshStatus(client);
					} finally {
						client?.close();
					}
					return;
				}
				case "on":
					process.exitCode = await mesh.meshOnCommand(args);
					return;
				case "off":
					process.exitCode = await mesh.meshOffCommand(args);
					return;
				case "list":
				case "allow":
				case "deny":
				case "forget":
				case "owner": {
					const { poolCommand } = await import("./pool-cli.ts");
					const client = await operatorClient();
					try {
						process.exitCode = await poolCommand(client, [verb, ...args]);
					} catch (e) {
						fail((e as Error).message);
					} finally {
						client.close();
					}
					return;
				}
				case "help":
				case "--help":
				case "-h":
					console.log(mesh.MESH_HELP);
					return;
				default:
					fail(`unknown mesh command "${verb}". Run pulsar mesh help.`);
			}
			return;
		}
		case "doctor": {
			const { values } = parseArgs({
				args: rest,
				options: { mesh: { type: "boolean" }, json: { type: "boolean" } },
			});
			const { runDoctor } = await import("./setup/doctor.ts");
			process.exitCode = await runDoctor({
				meshOnly: values.mesh === true,
				json: values.json === true,
			});
			return;
		}
		case "setup": {
			const { runSetup } = await import("./setup/index.ts");
			process.exitCode = await runSetup(rest);
			return;
		}
		default:
			fail(`unknown command "${command}". Run pulsar --help.`);
	}
}

main(process.argv.slice(2)).catch((e) => fail((e as Error).message));
