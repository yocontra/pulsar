import { type JsoncParser, useJsonc } from "./files.ts";

/**
 * Loads the JSONC parser for setup and doctor, before they read or edit
 * configs. The bundle uses its ESM build. Plain Node (`node src/cli.ts`)
 * refuses that build's extensionless imports, so it falls back to the
 * package entry (UMD), which the bundler in turn cannot resolve.
 */
export async function loadJsonc(): Promise<void> {
	let m: JsoncParser & { default?: JsoncParser };
	try {
		m = await import("jsonc-parser/lib/esm/main.js");
	} catch {
		m = (await import("jsonc-parser")) as unknown as typeof m;
	}
	useJsonc(typeof m.modify === "function" ? m : m.default!);
}
