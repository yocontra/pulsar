import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityCommands } from "../src/harnesses/antigravity-commands.ts";
import { Controls } from "../src/service/controls.ts";
import { agentRecord } from "./subagent-fixtures.ts";

let home: string;
let cwd: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pulsar-agy-skills-"));
	cwd = join(home, "bluepeak", "src");
	await mkdir(cwd, { recursive: true });
	await mkdir(join(home, "bluepeak", ".git"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function skill(parent: string, folder: string, name = folder) {
	const dir = join(parent, folder);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Run ${name}\n---\nInstructions`,
	);
	return join(dir, "SKILL.md");
}

test("Antigravity resolves CLI, project, configured, and built-in skills with native precedence", async () => {
	const config = join(home, ".gemini", "config");
	const shared = join(home, "external");
	await mkdir(config, { recursive: true });
	await skill(join(home, "bluepeak", ".agents", "skills"), "project");
	await skill(join(config, "skills"), "dupe");
	await skill(shared, "discard");
	await skill(shared, "picked", "selected");
	const first = await skill(
		join(home, ".gemini", "antigravity-cli", "skills"),
		"dupe",
	);
	await skill(
		join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
		"antigravity_guide",
		"antigravity-guide",
	);
	await writeFile(
		join(config, "skills.json"),
		JSON.stringify({
			entries: [{ path: "~/external", include_only: ["picked"] }],
			exclude: ["dupe"],
		}),
	);
	const entries = await antigravityCommands(cwd, home);
	expect(entries.map((e) => e.name).sort()).toEqual([
		"antigravity-guide",
		"dupe",
		"project",
		"selected",
	]);
	expect(entries.find((e) => e.name === "dupe")?.path).toBe(first);
});

test("native slash requests target the exact skill, verified user and session; terminal controls stay local", async () => {
	const file = await skill(
		join(home, "bluepeak", ".agents", "skills"),
		"my-skill",
	);
	const sessionId = "0000aaaa-1111-4222-8333-444455556666";
	await skill(
		join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
		"plugin",
	);
	const target = agentRecord({
		id: `antigravity:${sessionId}`,
		harness: "antigravity",
		sessionId,
		cwd,
		registered: true,
		reach: "pull",
	});
	const user = {
		kind: "human",
		login: "eric",
		node: "phone",
		verified: true,
	} as const;
	const calls: unknown[] = [];
	const controls = new Controls({
		lookup: () => target,
		sessions: { extensionFor: () => undefined },
		catalog: { home: () => home, version: async () => "1.5.16" },
		invokeSkill: async (agent, prompt, principal) => {
			calls.push([agent.id, prompt, principal]);
			return {
				result: "ok",
				via: "inbox",
				detail: "Queued for the next inbox check.",
			};
		},
	});
	const catalog = await controls.commands(target.id);
	expect(catalog.commands.find((c) => c.name === "plugin")?.terminalOnly).toBe(
		true,
	);
	expect(catalog.commands.find((c) => c.name === "skill:plugin")?.skill).toBe(
		true,
	);
	expect(
		(
			await controls.run(
				{ ...target, id: "antigravity:pid:42", sessionId: "pid:42" },
				"/my-skill",
				user,
			)
		).result,
	).toBe("unsupported");
	expect(catalog.runnable).toBe(true);
	expect(
		catalog.commands.find((e) => e.name === "my-skill"),
	).not.toHaveProperty("path");
	expect(catalog.commands.find((e) => e.name === "compact")?.terminalOnly).toBe(
		true,
	);
	expect(await controls.run(target, "/skills my", user)).toMatchObject({
		result: "ok",
		detail: expect.stringContaining("/my-skill"),
	});
	expect(await controls.run(target, "/help compact", user)).toMatchObject({
		result: "ok",
		detail: expect.stringContaining("terminal only"),
	});
	expect((await controls.run(target, "/compact please", user)).result).toBe(
		"unsupported",
	);
	expect((await controls.run(target, "/my-skill without auth")).result).toBe(
		"unsupported",
	);
	expect(
		(
			await controls.run(
				{ ...target, registered: false },
				"/my-skill missing inbox",
				user,
			)
		).result,
	).toBe("unsupported");
	expect(
		(await controls.run(target, "/my-skill verify the log", user)).via,
	).toBe("inbox");
	expect(calls).toEqual([
		[target.id, expect.stringContaining(JSON.stringify(file)), user],
	]);
	expect((calls[0] as string[])[1]).toContain("verify the log");
	await rm(file);
	expect((await controls.run(target, "/my-skill", user)).result).toBe(
		"unsupported",
	);
	expect(calls).toHaveLength(1);
});
