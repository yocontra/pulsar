import { defineConfig, devices } from "@playwright/test";
import {
	clearWorkerLogs,
	type E2EWorkerOptions,
	e2eWorkers,
	IN_WORKER,
	workerPort,
} from "./e2e/infra.ts";

// Every worker runs its own mock on its own free port (e2e/infra.ts), so the
// tests that change the mock's state run in parallel without colliding.
const PORT = workerPort("PULSAR_MOCK_PORT");
if (!IN_WORKER) clearWorkerLogs("mock");

/**
 * End-to-end runs against the mock API serving the built app (dist/web) with
 * the production CSP, so CSP violations fail the tests. Run with
 * `bun run test:e2e` (builds first). PULSAR_E2E_WORKERS sets the workers.
 */
export default defineConfig<unknown, E2EWorkerOptions>({
	testDir: "./e2e",
	testMatch: /.*\.e2e\.ts$/,
	outputDir: "./test-results",
	// A file's tests run in order on one worker (and one mock); files spread
	// over the workers.
	fullyParallel: false,
	workers: e2eWorkers(),
	retries: 0,
	timeout: 30_000,
	// A failed run prints the tail of each worker's e2e-logs/mock-w<n>.log.
	reporter: [["list"], ["./e2e/server-log-reporter.ts", { name: "mock" }]],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		serviceWorkers: "block",
		trace: "retain-on-failure",
		// The mock serves the daemon's features (approvals and push included).
		server: {
			name: "mock",
			script: "web/mock/server.ts",
			portEnv: "PULSAR_MOCK_PORT",
			env: { PULSAR_MOCK_STEADY: "1" },
		},
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
			// iOS gestures (swipe-back, swipe actions, sheets; no pull to refresh),
			// and the phone specs both platforms run (*.phone.e2e.ts).
			name: "ios",
			testMatch: /(ios|phone)\.e2e\.ts$/,
			// e2e/real/*.phone.e2e.ts run against a real daemon (playwright.real).
			testIgnore: /\/real\//,
			use: { ...devices["iPhone 13 Mini"] },
		},
		{
			// The phone on Android: Ionic's Material mode and Konsta's Material
			// theme (mobile/platform.ts picks them from the user agent).
			name: "android",
			testMatch: /(android|phone)\.e2e\.ts$/,
			testIgnore: /\/real\//,
			use: { ...devices["Pixel 7"] },
		},
	],
});
