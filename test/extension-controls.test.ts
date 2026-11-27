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

	for (const harness of ["pi", "omp"]) {
		test(`${harness} settings use exact registry entries and confirm the host applied them`, async () => {
			const base = {
				id: "same",
				provider: "a",
				reasoning: true,
				thinking: { efforts: ["low", "high"] },
				thinkingLevelMap: { medium: null },
			};
			const other = { ...base, provider: "b" };
			const ctx = {
				isIdle: () => true,
				model: base,
				modelRegistry: { getAvailable: () => [base, other] },
			};
			let effort = "low";
			const host = {
				ctx,
				harness,
				pi: {
					setModel: async (selected: typeof base) => {
						ctx.model = selected;
						return true;
					},
					getThinkingLevel: () => effort,
					setThinkingLevel: (value: string) => {
						effort = value;
					},
				},
			};
			const read = async () =>
				(await answerControl({ kind: "commands" }, host)).commands as {
					name: string;
					currentArgument: string;
					argumentChoices: { value: string }[];
				}[];
			const run = (line: string) =>
				answerControl({ kind: "setting", line }, host);
			expect(
				(await read())
					.find((c) => c.name === "effort")
					?.argumentChoices.map((c) => c.value),
			).not.toContain("medium");
			expect(await run("/model b/same")).toEqual({ result: "ok" });
			expect((await read())[0]?.currentArgument).toBe("b/same");
			expect(await run("/model same")).toMatchObject({ result: "unsupported" });
			expect(await run("/effort high")).toEqual({ result: "ok" });
			ctx.isIdle = () => false;
			expect(await run("/effort low")).toMatchObject({ result: "busy" });
			ctx.isIdle = () => true;
			host.pi.setThinkingLevel = () => {};
			expect(await run("/effort low")).toMatchObject({ result: "unsupported" });
			expect(effort).toBe("high");
		});
	}

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

	test("a command that starts a long turn is acknowledged while the turn is still running", async () => {
		let idle = true;
		const pending = new Promise<void>(() => {});
		const result = await answerControl(
			{ kind: "command", line: "/test" },
			{
				harness: "pi",
				ctx: { isIdle: () => idle },
				pi: {
					sendUserMessage() {
						idle = false;
						return pending;
					},
				},
			},
		);
		expect(result).toEqual({ result: "ok" });
	});

	test("omp declines terminal-only commands through the extension", async () => {
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

	test("OMP sends the exact installed skill path and arguments while idle", async () => {
		const sent: string[] = [];
		const host = {
			harness: "omp",
			ctx: { isIdle: () => true },
			pi: {
				getCommands: () => [
					{
						name: "skill:tidy",
						source: "skill",
						path: "/custom profile/tidy/SKILL.md",
					},
				],
				sendUserMessage: (s: string) => sent.push(s),
			},
		};
		expect(
			await answerControl(
				{ kind: "command", line: "/skill:tidy source files" },
				host,
			),
		).toEqual({ result: "ok" });
		expect(sent).toEqual([
			'Read the installed skill at "/custom profile/tidy/SKILL.md" and follow its instructions.\n\nUser request: source files',
		]);
		expect(
			await answerControl({ kind: "command", line: "/skill:missing" }, host),
		).toMatchObject({ result: "unsupported" });
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
