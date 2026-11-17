import { basename } from "node:path";
import type { HarnessDriver } from "./types.ts";

/** Detection only: pull-only, and `pulsar setup` does not configure it. */
export const vscode: HarnessDriver = {
	id: "vscode",
	label: "VS Code",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return args.includes("Visual Studio Code.app") || exe === "code";
	},
};
