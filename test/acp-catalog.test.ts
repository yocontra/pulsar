import { describe, expect, test } from "bun:test";
import { ACP_PROVIDERS } from "../src/harnesses/acp-catalog.ts";

describe("ACP provider catalog", () => {
	test("keeps provider IDs unique and uses local ACP executables", () => {
		expect(new Set(ACP_PROVIDERS.map((provider) => provider.id)).size).toBe(
			ACP_PROVIDERS.length,
		);
		for (const provider of ACP_PROVIDERS) {
			expect(provider.binary).toMatch(/^[a-z][a-z0-9-]*$/);
			expect(["npx", "uvx", "bunx", "npm", "sh", "bash"]).not.toContain(
				provider.binary,
			);
			expect(provider.source).toStartWith("https://");
		}
	});

	test("the published command table matches the catalog", async () => {
		const script = new URL("../scripts/acp-guide.ts", import.meta.url);
		const check = Bun.spawn([process.execPath, script.pathname, "--check"]);
		expect(await check.exited).toBe(0);
	});

	test("uses Antigravity as the Google ACP provider", () => {
		expect(
			ACP_PROVIDERS.filter((provider) =>
				provider.label.toLowerCase().includes("google"),
			).map(({ id, binary, args, distribution }) => [
				id,
				binary,
				...args,
				distribution,
			]),
		).toEqual([["antigravity", "agy", "acp", "native"]]);
	});

	test("uses the separate ACP executables for adapter-backed providers", () => {
		expect(
			Object.fromEntries(
				ACP_PROVIDERS.filter(
					(provider) => provider.distribution === "adapter",
				).map((provider) => [provider.id, [provider.binary, ...provider.args]]),
			),
		).toEqual({
			amp: ["amp-acp"],
			claude: ["claude-agent-acp"],
			codex: ["codex-acp"],
			deepagents: ["deepagents-acp"],
			"minimax-code": ["code-acp", "acp"],
			pi: ["pi-acp"],
		});
	});
});
