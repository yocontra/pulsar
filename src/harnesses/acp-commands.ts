import type { CommandEntry } from "../http/wire.ts";
import { antigravityCommands } from "./antigravity-commands.ts";

type LocalSkill = CommandEntry & { path: string };
type Command = { entry: CommandEntry; skillPath?: string };
const SKILL_REFRESH_MS = 5000;
const SKILL_CATALOG_LIMIT = 500;

/** Antigravity advertises native commands separately from its installed skills. */
export class AcpCommandCatalog {
	private skills: LocalSkill[] = [];
	private checkedAt = 0;
	private refreshing?: Promise<void>;
	private readonly options: { harness: string; cwd: string; home?: string };

	constructor(options: { harness: string; cwd: string; home?: string }) {
		this.options = options;
	}

	async refresh(): Promise<void> {
		if (
			this.options.harness !== "antigravity" ||
			Date.now() - this.checkedAt < SKILL_REFRESH_MS
		)
			return;
		this.refreshing ??= antigravityCommands(this.options.cwd, this.options.home)
			.then((skills) => {
				this.skills = skills.slice(0, SKILL_CATALOG_LIMIT);
			})
			.catch(() => {})
			.finally(() => {
				this.checkedAt = Date.now();
				this.refreshing = undefined;
			});
		await this.refreshing;
	}

	list(advertised: CommandEntry[]): Map<string, Command> {
		const entries = new Map<string, Command>();
		for (const entry of advertised) {
			if (!entries.has(entry.name)) entries.set(entry.name, { entry });
		}
		for (const { path, ...skill } of this.skills) {
			const qualified = `skill:${skill.name}`;
			const native = entries.get(qualified);
			if (native) {
				native.entry = {
					...skill,
					name: qualified,
					args: native.entry.args ?? skill.args,
				};
				continue;
			}
			// Keep a distinct entry if a provider command uses the same name.
			const name = entries.has(skill.name) ? qualified : skill.name;
			if (name.length > 128 || entries.has(name)) continue;
			entries.set(name, { entry: { ...skill, name }, skillPath: path });
		}
		return entries;
	}
}
