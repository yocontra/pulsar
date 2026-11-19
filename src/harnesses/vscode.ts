import { vscodeIdent } from "./simple-ident.ts";
import type { HarnessDriver } from "./types.ts";

/** Detection only: pull-only, and `pulsar setup` does not configure it. */
export const vscode: HarnessDriver = {
	...vscodeIdent,
};
