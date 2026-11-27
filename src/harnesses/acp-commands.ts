import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandEntry } from "../http/wire.ts";
import { projectDirs, skillFilesIn } from "../service/catalog-files.ts";
import { antigravityCommands } from "./antigravity-commands.ts";

type LocalSkill = CommandEntry & { path: string };
type Command = {
	entry: CommandEntry;
	skillPath?: string;
	revalidateSkill?: true;
};
const SKILL_REFRESH_MS = 5000;
const SKILL_CATALOG_LIMIT = 500;

/** ACP commands are authoritative except for Antigravity's native skill catalog. */
export class AcpCommandCatalog {
	private skills: LocalSkill[] = [];
	private knownAntigravitySkills = new Map<string, Set<string>>();
	private checkedAt = 0;
	private refreshing?: Promise<void>;
	private readonly options: { harness: string; cwd: string; home?: string };

	constructor(options: { harness: string; cwd: string; home?: string }) {
		this.options = options;
	}

	async refresh(force = false): Promise<void> {
		const { harness } = this.options;
		if (harness !== "antigravity" && harness !== "kilo") return;
		if (force && this.refreshing) await this.refreshing;
		if (!force && Date.now() - this.checkedAt < SKILL_REFRESH_MS) return;
		this.refreshing ??= this.installedSkills()
			.then((skills) => {
				this.skills = skills.slice(0, SKILL_CATALOG_LIMIT);
				if (harness === "antigravity")
					for (const skill of this.skills) {
						const descriptions =
							this.knownAntigravitySkills.get(skill.name) ?? new Set<string>();
						if (descriptions.size < 4) descriptions.add(skill.description);
						if (this.knownAntigravitySkills.size < SKILL_CATALOG_LIMIT)
							this.knownAntigravitySkills.set(skill.name, descriptions);
					}
			})
			.catch(() => {
				this.skills = [];
			})
			.finally(() => {
				this.checkedAt = Date.now();
				this.refreshing = undefined;
			});
		await this.refreshing;
	}

	private async installedSkills(): Promise<LocalSkill[]> {
		const { harness, cwd, home = homedir() } = this.options;
		if (harness === "antigravity") return antigravityCommands(cwd, home);
		const directories = await projectDirs(cwd, home);
		const inventory = await Promise.all([
			...directories.flatMap((dir) =>
				[".kilo", ".agents"].map((prefix) =>
					skillFilesIn(join(dir, prefix, "skills"), "project"),
				),
			),
			...[".kilo", ".agents"].map((prefix) =>
				skillFilesIn(join(home, prefix, "skills"), "user"),
			),
		]);
		return inventory.flat();
	}

	list(advertised: CommandEntry[]): Map<string, Command> {
		const entries = new Map<string, Command>();
		for (const entry of advertised) {
			if (entries.has(entry.name)) continue;
			if (this.options.harness === "antigravity") {
				const qualified = entry.name.startsWith("skill:");
				const name = qualified ? entry.name.slice("skill:".length) : entry.name;
				const descriptions = this.knownAntigravitySkills.get(name);
				if (
					descriptions &&
					(qualified || descriptions.has(entry.description))
				) {
					const local = this.skills.find((skill) => skill.name === name);
					if (!local) continue;
					const { path: _, ...skill } = local;
					entries.set(entry.name, {
						entry: {
							...skill,
							name: entry.name,
							args: entry.args ?? skill.args,
						},
						revalidateSkill: true,
					});
					continue;
				}
			}
			// Vibe identifies skills by their argument hint. Kilo uses a
			// suffix for collisions and otherwise advertises a bare name.
			const skill =
				(this.options.harness === "mistral-vibe" &&
					entry.args === "instructions for the skill") ||
				(this.options.harness === "kilo" &&
					(entry.name.endsWith(":skill") ||
						this.skills.some(
							(candidate) =>
								candidate.name === entry.name &&
								candidate.description === entry.description,
						)));
			entries.set(entry.name, {
				entry: skill ? { ...entry, skill: true } : entry,
			});
		}
		// Local records only annotate Kilo's advertised names. Its own ACP
		// catalog decides which names can be invoked.
		if (this.options.harness !== "antigravity") return entries;
		for (const { path, ...skill } of this.skills) {
			const qualified = `skill:${skill.name}`;
			if (
				entries.get(qualified)?.revalidateSkill ||
				entries.get(skill.name)?.revalidateSkill
			)
				continue;
			// Keep a distinct entry if a provider command uses the same name.
			const name = entries.has(skill.name) ? qualified : skill.name;
			if (name.length > 128 || entries.has(name)) continue;
			entries.set(name, {
				entry: { ...skill, name },
				skillPath: path,
				revalidateSkill: true,
			});
		}
		return entries;
	}
}
