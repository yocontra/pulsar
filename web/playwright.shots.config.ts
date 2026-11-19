import { defineConfig, devices } from "@playwright/test";
import { runPort, serverLog, sh } from "./e2e/infra.ts";

// Phone screenshots for design review: WebKit, iPhone 13 mini, light and dark.
// `bunx playwright test -c web/playwright.shots.config.ts` (build first).
// SHOTS_DIR picks the output folder (default web/screenshots/mobile/).
const PORT = runPort("PULSAR_MOCK_PORT");
const LOG = serverLog("mock-shots");
// Default: the installed app on the whole 375×812 screen. SHOTS_H picks
// another height (762: under an opaque status bar; 629: a Safari tab).
const phone = {
	...devices["iPhone 13 Mini"],
	viewport: { width: 375, height: Number(process.env.SHOTS_H ?? 812) },
};

export default defineConfig({
	testDir: "./e2e",
	testMatch: /.*\.shots\.ts$/,
	outputDir: "./test-results/shots",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [["list"]],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		serviceWorkers: "block",
	},
	webServer: {
		command: `bun web/mock/server.ts > ${sh(LOG)} 2>&1`,
		cwd: "..",
		env: { PULSAR_MOCK_PORT: String(PORT), PULSAR_MOCK_LIVE: "0" },
		url: `http://127.0.0.1:${PORT}/api/v1/hello`,
		reuseExistingServer: false,
		stdout: "ignore",
		timeout: 20_000,
	},
	projects: [
		{
			name: "light",
			use: { ...phone, colorScheme: "light" },
		},
		{
			name: "dark",
			use: { ...phone, colorScheme: "dark" },
		},
	],
});
