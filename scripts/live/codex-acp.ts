// Exercise both turns and negotiated controls through the production managed bridge.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PulsarService } from "../../src/service/index.ts";

export async function checkCodexAcp(
	service: PulsarService,
	cwd: string,
	baseURL: string,
	text: {
		first: string;
		reply: string;
		followup: string;
		resumedReply: string;
	},
) {
	const user = {
		kind: "human",
		login: "operator@example.test",
		node: "localhost",
		verified: true,
	} as const;
	const child = spawn(
		process.execPath,
		[resolve(import.meta.dir, "../../src/cli.ts"), "acp", "codex"],
		{
			cwd,
			env: {
				HOME: process.env.HOME,
				CODEX_HOME: process.env.CODEX_HOME,
				PATH: process.env.PATH,
				PULSAR_HOME: process.env.PULSAR_HOME,
				PULSAR_NO_SCAN: "1",
				PULSAR_NO_MESH: "1",
				OPENAI_API_KEY: "local-fixture-only",
				OPENAI_BASE_URL: baseURL,
			},
			stdio: ["pipe", "ignore", "pipe"],
		},
	);
	let diagnostics = "";
	child.stderr.on("data", (chunk) => {
		diagnostics = (diagnostics + String(chunk)).slice(-2000);
	});
	const closed = once(child, "exit");
	async function until(check: () => boolean | Promise<boolean>, step: string) {
		const deadline = Date.now() + 45000;
		while (
			Date.now() < deadline &&
			child.exitCode === null &&
			child.signalCode === null
		) {
			if (await check()) return;
			await delay(100);
		}
		throw new Error(`Codex ACP failed during ${step}. ${diagnostics}`);
	}
	try {
		const find = () =>
			service.registry
				.live()
				.find((a) => a.harness === "codex" && a.meta.acp === "1");
		await until(() => !!find(), "registration");
		const agent = find()!;
		const send = async (body: string, answer: string) => {
			await service.app.send(user, { ids: [agent.id], body });
			await until(
				async () =>
					(await service.transcripts.page(agent.id)).events.some(
						(e) => e.role === "assistant" && e.text.includes(answer),
					),
				"assistant transcript",
			);
		};
		await send(text.first, text.reply);
		await send(text.followup, text.resumedReply);
		// The loopback model emits this second reply only if it saw the first prompt,
		// its own first reply and the next user prompt in the same conversation.
		const catalog = await service.controls.commands(agent.id, user);
		console.log(
			"Codex ACP commands:",
			catalog.commands.map((c) => c.name).join(", "),
		);
		if (!catalog.commands.some((c) => c.name === "status"))
			throw new Error("Codex ACP did not publish /status");
		for (const name of ["model", "effort"]) {
			const option = catalog.commands.find((c) => c.name === name);
			const previous = option?.currentArgument;
			const other = option?.argumentChoices?.find(
				(c) => c.value !== previous,
			)?.value;
			if (!previous || !other)
				throw new Error(
					`Codex ACP did not publish selectable /${name} options`,
				);
			for (const value of [other, previous]) {
				await until(async () => {
					const result = await service.controls.run(
						agent,
						`/${name} ${value}`,
						user,
					);
					// The last transcript event can arrive before the provider settles the turn.
					if (result.result === "busy") return false;
					if (result.result !== "ok")
						throw Error(`/${name} selection failed: ${JSON.stringify(result)}`);
					return true;
				}, `/${name} selection`);
				const updated = await service.controls.commands(agent.id, user);
				if (
					updated.commands.find((c) => c.name === name)?.currentArgument !==
					value
				)
					throw Error(`/${name} did not confirm the choice`);
			}
			console.log(
				`Codex ACP /${name}: confirmed ${other} and restored ${previous}.`,
			);
		}
		console.log(
			"Codex ACP completed two Pulsar-delivered turns with the selected conversation's history.",
		);
	} finally {
		child.kill("SIGTERM");
		await closed;
	}
}
