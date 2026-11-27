import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AcpCommandCatalog } from "../src/harnesses/acp-commands.ts";
import type { CommandEntry } from "../src/http/wire.ts";

function advertised(
	name: string,
	description = "A workspace skill",
	args?: string,
): CommandEntry {
	return { name, description, source: "agent", args };
}

test("managed skills retain provider authority and qualify verified native syntax", async () => {
	const home = await mkdtemp(join(tmpdir(), "pulsar-acp-skills-"));
	try {
		const cwd = join(home, "workspace");
		for (const name of ["review-branch", "disabled", "user-command"]) {
			const path = join(cwd, ".kilo", "skills", name, "SKILL.md");
			await mkdir(dirname(path), { recursive: true });
			await writeFile(
				path,
				`---\nname: ${name}\ndescription: A workspace skill\n---\nExample.\n`,
			);
		}
		const kilo = new AcpCommandCatalog({ harness: "kilo", cwd, home });
		await kilo.refresh();
		const entries = kilo.list([
			advertised("review-branch"),
			advertised("user-command", "The provider command with the same name"),
			advertised("user-command:skill"),
		]);
		expect(entries.get("review-branch")).toEqual({
			entry: { ...advertised("review-branch"), skill: true },
		});
		expect(entries.get("user-command")?.entry.skill).toBeUndefined();
		expect(entries.get("user-command:skill")?.entry.skill).toBe(true);
		expect(entries.has("disabled")).toBe(false);
		expect(kilo.list([]).size).toBe(0);

		const command = advertised(
			"test",
			"An advertised command",
			"instructions for the skill",
		);
		const vibe = new AcpCommandCatalog({ harness: "mistral-vibe", cwd, home });
		expect(vibe.list([command]).get("test")).toEqual({
			entry: { ...command, skill: true },
		});
		const other = new AcpCommandCatalog({ harness: "opencode", cwd, home });
		await other.refresh();
		expect(other.list([command]).get("test")?.entry.skill).toBeUndefined();
		expect(
			other.list([advertised("user-command:skill")]).get("user-command:skill")
				?.entry.skill,
		).toBeUndefined();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
