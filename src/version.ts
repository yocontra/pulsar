import { createRequire } from "node:module";

// Both src/ and dist/ sit one level below package.json.
const pkg = createRequire(import.meta.url)("../package.json") as {
	version: string;
	name: string;
};

export const VERSION: string = pkg.version;
export const PACKAGE_NAME: string = pkg.name;
