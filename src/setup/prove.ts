import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { DaemonClient } from "../client.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { VERSION } from "../version.ts";

/** How long setup waits for the passkey before it moves on. */
const WAIT_MS = 5 * 60_000;
const POLL_MS = 2000;

/** The line printed when the step is skipped. */
const PROVE_LATER =
	"You can prove you're human anytime from Prove Human in the app.";

async function ask(question: string): Promise<boolean> {
	const rl = createPrompt({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
	rl.close();
	return answer === "" || answer === "y" || answer === "yes";
}

/**
 * The optional last step of `pulsar mesh on` (and of setup when the mesh is on): register a passkey on any device
 * signed in to the tailnet, so approvals and messages from the app are known
 * to be the operator's. Asked only at a terminal (never with --yes, unless
 * --prove asks for it) and only when the app is on.
 */
export async function offerProveHuman(opts: {
	yes: boolean;
	prove: boolean;
}): Promise<void> {
	const tty = process.stdin.isTTY && process.stdout.isTTY;
	if (!tty || (opts.yes && !opts.prove)) return;
	const { appUrlOrReason } = await import("../http/config.ts");
	const r = await appUrlOrReason();
	if ("reason" in r) return;
	const url = `${r.url.replace(/\/?$/, "/")}#/prove`;
	if (
		!opts.prove &&
		!(await ask(
			"\nSet up a passkey for approvals now? Your device's passkey (Face ID, Touch ID, Windows Hello, or your device PIN) proves to Pulsar that it's you.",
		))
	) {
		console.log(PROVE_LATER);
		return;
	}
	const client = new DaemonClient();
	try {
		await client.connect(true);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		const before = new Set((await listPasskeys(client)).map((p) => p.id));
		console.log(
			`\nOpen this on any device signed in to your tailnet:\n  ${url}`,
		);
		if (await ask("Open it in this machine's browser?")) await openUrl(url);
		const { terminalQr } = await import("./mesh.ts");
		console.log(`\nOr scan it with a phone:\n${await terminalQr(url)}`);
		const added = await waitForPasskey(client, before);
		console.log(
			added
				? `✓ Proven: passkey '${added}' is set up on this machine.`
				: `Skipped. ${PROVE_LATER}`,
		);
	} catch (e) {
		console.log(
			`Could not check for a passkey: ${(e as Error).message}. ${PROVE_LATER}`,
		);
	} finally {
		client.close();
	}
}

async function listPasskeys(client: DaemonClient) {
	const r = await client.call<{ passkeys: { id: string; label: string }[] }>(
		"passkeys.list",
	);
	return r.passkeys;
}

/** The label of a passkey added after `before`, or null on Enter or timeout. */
async function waitForPasskey(
	client: DaemonClient,
	before: Set<string>,
): Promise<string | null> {
	console.log("Waiting for the passkey… (press Enter to skip)");
	const rl = createInterface({ input: process.stdin });
	let skipped = false;
	rl.once("line", () => {
		skipped = true;
	});
	const until = Date.now() + WAIT_MS;
	try {
		while (!skipped && Date.now() < until) {
			const fresh = (await listPasskeys(client)).find((p) => !before.has(p.id));
			if (fresh) return fresh.label;
			await new Promise((res) => setTimeout(res, POLL_MS));
		}
		return null;
	} finally {
		rl.close();
	}
}

const OPENERS: Partial<Record<NodeJS.Platform, string>> = {
	darwin: "open",
	win32: "explorer",
};

async function openUrl(url: string) {
	const { runCommand } = await import("./service.ts");
	const opener = OPENERS[process.platform] ?? "xdg-open";
	const r = await runCommand(opener, [url]);
	if (!r.ok)
		console.log(`Could not open a browser here; open ${url} yourself.`);
}
