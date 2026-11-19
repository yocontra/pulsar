import { defineConfig, devices } from "@playwright/test";
import { runPort, serverLog, sh } from "./e2e/infra.ts";

// The README's screenshots (docs/assets/screenshots/): a small mock pool, the
// phone in WebKit (iPhone 13 mini) and the desktop in Chromium at 1440×900.
// `bun run build:web && bunx playwright test -c web/playwright.readme-shots.config.ts`,
// then convert the PNGs to WebP (see web/e2e/readme.screens.ts).
const PORT = runPort("PULSAR_MOCK_PORT");
const LOG = serverLog("mock-readme-shots");

export default defineConfig({
	testDir: "./e2e",
	testMatch: /readme\.screens\.ts$/,
	outputDir: "./test-results/readme-shots",
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
			PULSAR_MOCK_POOL: "small",
			PULSAR_MOCK_STREAM: "0",
		},
		url: `http://127.0.0.1:${PORT}/api/v1/hello`,
		reuseExistingServer: false,
		stdout: "ignore",
		timeout: 20_000,
	},
	projects: [
		{
			name: "phone",
			use: {
				...devices["iPhone 13 Mini"],
				viewport: { width: 375, height: 812 },
			},
		},
		{
			name: "desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
	],
});
