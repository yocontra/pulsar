// An isolated home node with the same passkey session and launch API used by the app.
import { join } from "node:path";
import { StaticIdentity } from "../../src/http/identity.ts";
import type { LaunchState } from "../../src/http/wire.ts";
import { socketPath } from "../../src/paths.ts";
import { PulsarService } from "../../src/service/index.ts";
import { Store } from "../../src/store.ts";
import { HttpTransport } from "../../src/transport/http.ts";
import { SocketTransport } from "../../src/transport/socket.ts";
import { SoftAuthenticator } from "../../test/webauthn.ts";

export async function resumeHost(root: string) {
	const owner = "operator@example.test";
	const store = new Store(join(root, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: "qualification",
		presence: { native: null },
		search: { off: true },
		launch: {
			tmux: { socket: "qualification" },
			shell: "/bin/sh",
			timing: { pollMs: 200, readyMs: 45000 },
		},
	});
	const socket = new SocketTransport(service, socketPath());
	const http = new HttpTransport(service, {
		identity: new StaticIdentity(owner, "qualification"),
		owner,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
	});
	let token = "";
	async function close() {
		await http.close();
		await socket.close();
		service.stop();
		store.close();
	}
	try {
		if (!(await socket.listen())) throw Error("Fixture socket unavailable");
		await http.listen();
		service.start();
		const base = `http://127.0.0.1:${http.port}`;
		const origin = `http://localhost:${http.port}`;
		async function post<T>(path: string, body: unknown): Promise<T> {
			const res = await fetch(`${base}/api/v1${path}`, {
				method: "POST",
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
					"X-Pulsar": "1",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) throw Error(`${path}: ${res.status} ${await res.text()}`);
			return (await res.json()) as T;
		}
		const key = new SoftAuthenticator({ origin, rpId: "localhost" });
		const reg = await post<{ options: Parameters<typeof key.register>[0] }>(
			"/passkeys/register/options",
			{ label: "Fixture" },
		);
		await post("/passkeys/register/verify", {
			response: key.register(reg.options),
		});
		const auth = await post<{
			requestId: string;
			options: Parameters<typeof key.assert>[0];
		}>("/session/options", { device: "Fixture" });
		token = (
			await post<{ token: string }>("/session/verify", {
				requestId: auth.requestId,
				assertion: key.assert(auth.options),
			})
		).token;
		return {
			close,
			service,
			launch: (harness: string, cwd: string, id: string) =>
				post<LaunchState>("/agents/launch", {
					params: {
						nonce: crypto.randomUUID(),
						harness,
						cwd,
						workspace: "current",
						resumeSessionId: id,
					},
				}),
		};
	} catch (e) {
		await close();
		throw e;
	}
}
