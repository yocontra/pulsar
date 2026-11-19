import { defineConfig, devices } from "@playwright/test";
import { runPort, serverLog, sh } from "./e2e/infra.ts";

// Free ports per run (see e2e/infra.ts); the daemon's HOME and PULSAR_HOME
// are fresh temp folders per run (e2e/real/daemon.ts).
const PORT = runPort("PULSAR_REAL_PORT");
runPort("PULSAR_REAL_CONTROL_PORT");
// The same daemon over HTTPS (HTTP/2) with a throwaway certificate (tls.e2e.ts).
runPort("PULSAR_REAL_TLS_PORT");
const LOG = serverLog("real");

/**
 * The `@real` suite: the built app (dist/web) served by a real pulsar daemon
 * (dev identity, 127.0.0.1) with fake agents on its socket, in a temp HOME
 * and PULSAR_HOME. See e2e/real/daemon.ts.
 */
export default defineConfig({
	testDir: "./e2e/real",
	testMatch: /.*\.e2e\.ts$/,
	grep: /@real/,
	outputDir: "./test-results/real",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 30_000,
	reporter: [["list"], ["./e2e/server-log-reporter.ts", { file: LOG }]],
	use: {
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 900 },
		baseURL: `http://127.0.0.1:${PORT}`,
		serviceWorkers: "block",
		trace: "retain-on-failure",
	},
	webServer: {
		command: `bun web/e2e/real/daemon.ts > ${sh(LOG)} 2>&1`,
		cwd: "..",
		env: {
			PULSAR_REAL_PORT: String(PORT),
			PULSAR_REAL_CONTROL_PORT: String(process.env.PULSAR_REAL_CONTROL_PORT),
			PULSAR_REAL_TLS_PORT: String(process.env.PULSAR_REAL_TLS_PORT),
			// Never a real Touch ID prompt from the test daemon (docs/presence.md).
			PULSAR_NATIVE_PRESENCE: "off",
		},
		url: `http://127.0.0.1:${PORT}/api/v1/hello`,
		reuseExistingServer: false,
		stdout: "ignore",
		timeout: 20_000,
	},
});
