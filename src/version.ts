import { createRequire } from "node:module";

// Both src/ and dist/ sit one level below package.json.
const pkg = createRequire(import.meta.url)("../package.json") as {
	version: string;
};

export const VERSION: string = pkg.version;
