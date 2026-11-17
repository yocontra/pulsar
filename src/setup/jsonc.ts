import { useJsonc } from "./files.ts";

/** Loads the JSONC parser for setup and doctor, before they read or edit configs. */
export async function loadJsonc(): Promise<void> {
	useJsonc(await import("jsonc-parser/lib/esm/main.js"));
}
