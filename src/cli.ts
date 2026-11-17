#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DaemonClient } from "./client.ts";
import { agentsText, messageText, receiptsText } from "./format.ts";
import { detectRegistration } from "./identity.ts";
import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
} from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";
import { VERSION } from "./version.ts";

const HELP = `pulsar ${VERSION} — find and message AI agents across every harness on this machine

Usage:
  pulsar setup [--yes] [--all-detected] [--client <name>]... [--dry-run] [--no-mcp] [--skills-dir <path>] [--uninstall]
                                  configure your agents (Claude Code, Codex, OpenCode, pi, omp, Cursor, Gemini)
  pulsar ls [selector]            list live agents (selector: name, project=x, harness=codex, tag, *)
  pulsar send <to> <message...>   send as "operator" (to: name, selector, or '*')
        [--priority urgent|normal|fyi] [--expect-reply]
  pulsar reply <id> <message...>  answer a message in its thread
  pulsar inbox                    read replies sent to you (operator)
  pulsar tail                     stream agents joining/leaving and every message
  pulsar doctor                   check the daemon and each harness integration
  pulsar status                   daemon status
  pulsar stop                     stop the daemon (it restarts on next use)
  pulsar mcp                      run the MCP server (your agent's config runs this)
  pulsar daemon                   run the daemon in the foreground

https://github.com/yocontra/pulsar`;

async function operatorClient(autoStart = true) {
	const client = new DaemonClient();
	await client.connect(autoStart);
	// Run from a terminal, this is the operator. Run from an agent's shell, it is that agent.
	await client.call("hello", {
		protocol: PROTOCOL_VERSION,
		version: VERSION,
		registration: detectRegistration("cli"),
	});
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
		case "--version":
		case "-v":
		case "version":
			console.log(VERSION);
			return;
		case "mcp": {
			const { runMcp } = await import("./mcp.ts");
			await runMcp();
			return;
		}
		case "daemon": {
			const { runDaemon } = await import("./run-daemon.ts");
			await runDaemon();
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
				},
				allowPositionals: true,
			});
			const [to, ...words] = positionals;
			if (!to || words.length === 0)
				fail("usage: pulsar send <to> <message...>");
			const client = await operatorClient();
			const r = await client.call<{ message: Message; receipts: Receipt[] }>(
				"send",
				{
					to,
					body: words.join(" "),
					priority: values.priority ?? "normal",
					expectReply: values["expect-reply"] ?? false,
				},
			);
			console.log(
				`Sent ${r.message.id} to ${r.receipts.length} agent(s):\n${receiptsText(r.receipts)}`,
			);
			client.close();
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
					`${new Date().toLocaleTimeString()}  msg    ${message.fromName} → ${message.to} (${recipients.join(", ")}): ${message.body.replace(/\s+/g, " ").slice(0, 160)}`,
				);
			});
			await client.call("tail");
			console.log("Watching pulsar traffic. Ctrl-C to stop.");
			client.onClose(() => process.exit(0));
			await new Promise(() => {});
			return;
		}
		case "status": {
			try {
				const client = await operatorClient(false);
				console.log(JSON.stringify(await client.call("status"), null, 2));
				client.close();
			} catch {
				console.log("daemon: not running (it starts on first use)");
			}
			return;
		}
		case "stop": {
			try {
				const client = await operatorClient(false);
				await client.call("shutdown");
				client.close();
				console.log("daemon stopped");
			} catch {
				console.log("daemon was not running");
			}
			return;
		}
		case "doctor": {
			const { runDoctor } = await import("./setup/doctor.ts");
			process.exitCode = await runDoctor();
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
