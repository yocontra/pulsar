import { defineConfig, devices } from "@playwright/test";
import { runPort, serverLog, sh } from "./e2e/infra.ts";

// Desktop screenshots for design review: Chromium at 1440×900 and 1280×800,
// light and dark. `bunx playwright test -c web/playwright.desktop-shots.config.ts`
// (build first). SHOTS_DIR picks the output folder (default web/screenshots/desktop/).
const PORT = runPort("PULSAR_MOCK_PORT");
const LOG = serverLog("mock-desktop-shots");
const size = (width: number, height: number) => ({
	...devices["Desktop Chrome"],
	viewport: { width, height },
});

export default defineConfig({
	testDir: "./e2e",
	testMatch: /desktop\.screens\.ts$/,
	outputDir: "./test-results/desktop-shots",
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
		env: {
			PULSAR_MOCK_PORT: String(PORT),
			PULSAR_MOCK_LIVE: "0",
			PULSAR_MOCK_FEATURES: "approvals",
		},
		url: `http://127.0.0.1:${PORT}/api/v1/hello`,
		reuseExistingServer: false,
		stdout: "ignore",
		timeout: 20_000,
	},
	projects: [
		{ name: "1440-light", use: { ...size(1440, 900), colorScheme: "light" } },
		{ name: "1440-dark", use: { ...size(1440, 900), colorScheme: "dark" } },
		{ name: "1280-light", use: { ...size(1280, 800), colorScheme: "light" } },
		{ name: "1280-dark", use: { ...size(1280, 800), colorScheme: "dark" } },
	],
});
