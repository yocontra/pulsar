// Update the command table after changing the in-tree ACP catalog.
import { readFile, writeFile } from "node:fs/promises";
import { ACP_PROVIDERS } from "../src/harnesses/acp-catalog.ts";

const file = new URL("../docs/acp.md", import.meta.url);
const guide = await readFile(file, "utf8");
const begin = "<!-- acp-catalog:start -->";
const end = "<!-- acp-catalog:end -->";
const start = guide.indexOf(begin);
const finish = guide.indexOf(end, start);
if (start < 0 || finish < 0) throw new Error("ACP command table is missing");

const table = [
	"| Provider ID | Local command | Integration | Reference |",
	"| --- | --- | --- | --- |",
	...ACP_PROVIDERS.map((provider) => {
		const command = [provider.binary, ...provider.args].join(" ");
		return `| \`${provider.id}\` | \`${command}\` | ${provider.distribution} | [${provider.label}](${provider.source}) |`;
	}),
].join("\n");
const updated =
	guide.slice(0, start) +
	[begin, table, end].join("\n") +
	guide.slice(finish + end.length);
if (process.argv.includes("--check")) {
	if (guide !== updated) throw new Error("Run bun scripts/acp-guide.ts");
} else if (guide !== updated) {
	await writeFile(file, updated);
}
