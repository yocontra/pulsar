import { exec } from "../exec.ts";
import { antigravitySkillPrompt } from "../harnesses/antigravity-commands.ts";
import { ANTIGRAVITY_SESSION_ID } from "../harnesses/antigravity-ident.ts";
import type { ControlResult } from "../http/wire.ts";
import type { Agent } from "../types.ts";
import type { VerifiedUser } from "./acting.ts";
import type { Catalogs } from "./catalog.ts";

export type InvokeSkill = (
	agent: Agent,
	prompt: string,
	user: VerifiedUser,
) => Promise<Omit<ControlResult, "agentId">>;

export async function runAntigravityCommand(
	agent: Agent,
	cmd: { name: string; args: string },
	catalogs: Catalogs,
	invokeSkill?: InvokeSkill,
	user?: VerifiedUser,
): Promise<ControlResult> {
	const done = (r: Omit<ControlResult, "agentId">): ControlResult => ({
		agentId: agent.id,
		...r,
	});
	const via = "antigravity";
	const { commands } = await catalogs.list(agent);
	const entry = commands.find((item) => item.name === cmd.name);
	if (!entry || entry.terminalOnly)
		return done({
			result: "unsupported",
			via,
			detail: entry
				? `Run /${cmd.name} in the Antigravity terminal.`
				: "Antigravity has no command with that name.",
		});
	if (cmd.name === "changelog") {
		const log = await exec("agy", ["changelog"], {
			lane: "user",
			timeoutMs: 5000,
		});
		return done(
			log.ok
				? {
						result: "ok",
						via,
						detail: log.stdout
							.trim()
							.split(/\n(?=\d+\.\d+\.\d+:)/)[0]!
							.slice(0, 3000),
					}
				: {
						result: "failed",
						via,
						detail: "Could not read the installed Antigravity release notes.",
					},
		);
	}
	if (cmd.name === "help" || cmd.name === "skills") {
		const search = cmd.args.toLowerCase().replace(/^\//, "");
		const matches = commands.filter(
			(c) =>
				(cmd.name === "help" || c.skill) &&
				c.name.toLowerCase().includes(search),
		);
		const rows = matches
			.slice(0, 30)
			.map(
				(c) =>
					`/${c.name} — ${c.description}${c.terminalOnly ? " (terminal only)" : ""}`,
			);
		while (rows.join("\n").length > 2900) rows.pop();
		if (rows.length < matches.length)
			rows.push(
				`Showing ${rows.length} of ${matches.length}. Search with /${cmd.name} <name>.`,
			);
		const detail = rows.join("\n") || "No matches.";
		return done({ result: "ok", via, detail });
	}
	if (!invokeSkill || !user?.verified)
		return done({
			result: "unsupported",
			via,
			detail: "Prove Human to invoke a skill in this conversation.",
		});
	if (
		!agent.sessionId ||
		!ANTIGRAVITY_SESSION_ID.test(agent.sessionId) ||
		agent.id !== `antigravity:${agent.sessionId}` ||
		agent.status === "gone"
	)
		return done({
			result: "unsupported",
			via,
			detail: "Antigravity has not confirmed the active conversation ID.",
		});
	if (!agent.registered && agent.reach !== "push")
		return done({
			result: "unsupported",
			via,
			detail:
				"This Antigravity session has no connected Pulsar inbox or wake relay.",
		});
	const skill = (await catalogs.antigravitySkills(agent)).find(
		(s) => s.name === cmd.name,
	);
	if (!skill)
		return done({
			result: "unsupported",
			via,
			detail: "This skill is no longer installed.",
		});
	const prompt = antigravitySkillPrompt(skill.path, cmd.args);
	return done(await invokeSkill(agent, prompt, user));
}
