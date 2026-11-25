import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../harnesses/claude-ident.ts";
import { type Providers, readProviders } from "./local.ts";
import type { UsageHarness } from "./parse.ts";

interface UsageSource {
	root(): string;
	layout: "calendar" | "projects";
	children: string;
	session(name: string): string;
	providers?(root: string): Promise<Providers>;
}
const stem = (name: string) => name.replace(/\.jsonl$/, "");
function extensionSource(id: "pi" | "omp"): UsageSource {
	return {
		root: () => join(homedir(), `.${id}`, "agent", "sessions"),
		layout: "projects",
		children: "",
		session: (name) => stem(name).replace(/^[^_]*_/, ""),
		providers: (root) => readProviders(id, root),
	};
}
export const usageSources: Record<UsageHarness, UsageSource> = {
	claude: {
		root: () => join(configDir(), "projects"),
		layout: "projects",
		children: "subagents",
		session: stem,
	},
	codex: {
		root: () =>
			join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
		layout: "calendar",
		children: "",
		session: (name) =>
			/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(stem(name))?.[1] ??
			stem(name),
		providers: (root) => readProviders("codex", root),
	},
	pi: extensionSource("pi"),
	omp: extensionSource("omp"),
};
