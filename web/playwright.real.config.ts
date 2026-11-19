import { defineConfig, devices } from "@playwright/test";
import {
	clearWorkerLogs,
	type E2EWorkerOptions,
	e2eWorkers,
	IN_WORKER,
	workerPort,
} from "./e2e/infra.ts";

// Every worker runs its own daemon on its own free ports (e2e/infra.ts), with
// its own fresh temp HOME and PULSAR_HOME (e2e/real/daemon.ts).
const PORT = workerPort("PULSAR_REAL_PORT");
workerPort("PULSAR_REAL_CONTROL_PORT");
// The same daemon over HTTPS (HTTP/2) with a throwaway certificate (tls.e2e.ts).
workerPort("PULSAR_REAL_TLS_PORT");
if (!IN_WORKER) clearWorkerLogs("real");

/**
 * The `@real` suite: the built app (dist/web) served by a real pulsar daemon
 * (dev identity, 127.0.0.1) with fake agents on its socket, in a temp HOME
 * and PULSAR_HOME. See e2e/real/daemon.ts.
 */
export default defineConfig<unknown, E2EWorkerOptions>({
	testDir: "./e2e/real",
	testMatch: /.*\.e2e\.ts$/,
	grep: /@real/,
	outputDir: "./test-results/real",
	fullyParallel: false,
	workers: e2eWorkers(),
	retries: 0,
	timeout: 30_000,
	reporter: [["list"], ["./e2e/server-log-reporter.ts", { name: "real" }]],
	use: {
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 900 },
		baseURL: `http://127.0.0.1:${PORT}`,
		serviceWorkers: "block",
		trace: "retain-on-failure",
		server: {
			name: "real",
			script: "web/e2e/real/daemon.ts",
			portEnv: "PULSAR_REAL_PORT",
			// Never a real Touch ID prompt from the test daemon (docs/presence.md).
			env: { PULSAR_NATIVE_PRESENCE: "off" },
			// Agents registered, control and TLS servers listening.
			readyLine: "real daemon: app",
		},
	},
});
