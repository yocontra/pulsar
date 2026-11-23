import { describe, expect, test } from "bun:test";
import { answerControl } from "../src/extension.ts";

/**
 * The pulsar extension's side of modes and slash commands
 * (src/extension.ts `answerControl`), on fake pi / omp hosts.
 */

describe("extension control requests", () => {
	test("commands: pi.getCommands(), with each one's file", async () => {
		const r = await answerControl(
			{ kind: "commands" },
			{
				pi: {
					getCommands: () => [
						{
							name: "skill:tidy",
							description: "Tidy",
							source: "skill",
							sourceInfo: { path: "/w/SKILL.md" },
						},
						{ name: "deploy", source: "extension" },
					],
				},
				ctx: undefined,
				harness: "pi",
			},
		);
		expect(r).toEqual({
			result: "ok",
			commands: [
				{
					name: "skill:tidy",
					description: "Tidy",
					source: "skill",
					path: "/w/SKILL.md",
				},
				{
					name: "deploy",
					description: undefined,
					source: "extension",
					path: undefined,
				},
			],
		});
	});

	test("pi runs a command line while idle, expanding templates; not mid-turn", async () => {
		const sent: Array<[string, unknown]> = [];
		const pi = {
			sendUserMessage: (t: string, o?: unknown) => sent.push([t, o]),
		};
		let idle = true;
		const ctx = { isIdle: () => idle };
		expect(
			await answerControl(
				{ kind: "command", line: "/skill:tidy src" },
				{ pi, ctx, harness: "pi" },
			),
		).toEqual({ result: "ok" });
		expect(sent).toEqual([
			["/skill:tidy src", { expandPromptTemplates: true }],
		]);
		idle = false;
		expect(
			await answerControl(
				{ kind: "command", line: "/x" },
				{ pi, ctx, harness: "pi" },
			),
		).toMatchObject({ result: "busy" });
		expect(sent).toHaveLength(1);
	});

	test("omp never runs a command line from here", async () => {
		const sent: string[] = [];
		expect(
			await answerControl(
				{ kind: "command", line: "/plan" },
				{
					pi: { sendUserMessage: (t: string) => sent.push(t) },
					ctx: {},
					harness: "omp",
				},
			),
		).toMatchObject({ result: "unsupported" });
		expect(sent).toEqual([]);
	});

	test("omp plan mode: read, enter, exit, and the host's refusal", async () => {
		let plan = false;
		let refuse: string | null = null;
		const calls: unknown[] = [];
		const ctx = {
			sessionModes: {
				getState: () => ({ plan: { status: plan ? "active" : "inactive" } }),
				set: async (req: { mode: string; action: "enter" | "exit" }) => {
					calls.push(req);
					if (refuse)
						return { ok: false, error: refuse, message: `no: ${refuse}` };
					plan = req.action === "enter";
					return { ok: true };
				},
			},
		};
		const host = { pi: {}, ctx, harness: "omp" };
		expect(await answerControl({ kind: "mode.get" }, host)).toEqual({
			result: "ok",
			mode: "default",
		});
		expect(
			await answerControl({ kind: "mode.set", mode: "plan" }, host),
		).toEqual({ result: "ok", mode: "plan" });
		// Already there: no call.
		expect(
			await answerControl({ kind: "mode.set", mode: "plan" }, host),
		).toEqual({ result: "ok", mode: "plan" });
		expect(calls).toEqual([{ mode: "plan", action: "enter" }]);
		refuse = "busy";
		expect(
			await answerControl({ kind: "mode.set", mode: "default" }, host),
		).toEqual({
			result: "busy",
			detail: "no: busy",
			mode: "plan",
		});
	});

	test("a host without mode control", async () => {
		expect(
			await answerControl(
				{ kind: "mode.get" },
				{ pi: {}, ctx: {}, harness: "pi" },
			),
		).toMatchObject({ result: "unsupported" });
	});
});
