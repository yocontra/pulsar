import { defineConfig, devices } from "@playwright/test";
import { runPort, serverLog, sh } from "./e2e/infra.ts";

// A free port per run (see e2e/infra.ts): concurrent runs never share a server.
const PORT = runPort("PULSAR_MOCK_PORT");
const LOG = serverLog("mock");

/**
 * End-to-end runs against the mock API serving the built app (dist/web) with
 * the production CSP, so CSP violations fail the tests. Run with
 * `bun run test:e2e` (builds first).
 */
export default defineConfig({
	testDir: "./e2e",
	testMatch: /.*\.e2e\.ts$/,
	outputDir: "./test-results",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 30_000,
	reporter: [["list"], ["./e2e/server-log-reporter.ts", { file: LOG }]],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		serviceWorkers: "block",
		trace: "retain-on-failure",
	},
	webServer: {
		// The mock's output goes to e2e-logs/mock.log; a failed run prints its tail.
		command: `bun web/mock/server.ts > ${sh(LOG)} 2>&1`,
		cwd: "..",
		// The mock serves the daemon's features (approvals and push included).
		env: { PULSAR_MOCK_PORT: String(PORT), PULSAR_MOCK_STEADY: "1" },
		url: `http://127.0.0.1:${PORT}/api/v1/hello`,
		reuseExistingServer: false,
		stdout: "ignore",
		timeout: 20_000,
	},
	projects: [
		{
			name: "desktop",
			testMatch: /desktop(-skeleton)?\.e2e\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			// Server-side changes show in the UI within 1 s, without a reload.
			name: "realtime",
			testMatch: /realtime\.e2e\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			// Slow first load, failed chunks, service worker builds, headers.
			name: "load",
			testMatch: /load\.e2e\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			// A slow, failing network: instant feedback, rollback, no duplicates.
			name: "optimistic",
			testMatch: /optimistic\.e2e\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			name: "mobile",
			testMatch: /mobile\.e2e\.ts$/,
			use: { ...devices["Pixel 7"] },
		},
		{
			// Questions, plans and dialogs answered from the desktop dialog...
			name: "interactions-desktop",
			testMatch: /interactions\.e2e\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			// ...and from the phone's sheet (Chromium: virtual passkeys need CDP).
			name: "interactions-phone",
			testMatch: /interactions\.e2e\.ts$/,
			use: { ...devices["Pixel 7"] },
		},
		{
			// Prove Human once: one passkey check per session, shared by tabs.
			name: "prove-once-desktop",
			testMatch: /prove-once\.e2e\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			name: "prove-once-phone",
			testMatch: /prove-once\.e2e\.ts$/,
			use: { ...devices["Pixel 7"] },
		},
		{
			// iOS gestures (swipe-back, swipe actions, sheets, pull to refresh).
			name: "ios",
			testMatch: /ios\.e2e\.ts$/,
			use: { ...devices["iPhone 13 Mini"] },
		},
	],
});
