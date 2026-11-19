import { execFile } from "node:child_process";

/**
 * The operating system's own check that the person at this computer is here:
 * Touch ID, Apple Watch or the login password on macOS; Windows Hello on
 * Windows; a polkit agent on a Linux desktop (only with Pulsar's polkit action
 * installed). The daemon runs it itself, as a child process, so nothing a
 * client sends can say "the check passed".
 *
 * Outcomes:
 * - `granted`: the person verified.
 * - `denied`: the person said no (cancelled the dialog or failed it).
 * - `unavailable`: no way to ask here (no sensor and no password set, no GUI
 *   session, the system dismissed the dialog). The caller tries another way.
 * - `timeout`: nobody answered in time (or the caller gave up).
 */
export type PresenceOutcome = "granted" | "denied" | "unavailable" | "timeout";

export interface PresenceProvider {
	/** "Touch ID", "Windows Hello", "polkit": shown in the CLI and audited. */
	readonly method: string;
	/** True when this machine can show the prompt now (cheap, no UI). */
	available(): Promise<boolean>;
	/**
	 * Shows the prompt with `reason` (the exact action) and waits. Aborting
	 * `signal` ends the child, which takes the dialog down.
	 */
	verify(
		reason: string,
		opts: { signal: AbortSignal; timeoutMs: number },
	): Promise<PresenceOutcome>;
}

interface Run {
	code: number | null;
	stdout: string;
	aborted: boolean;
}

/** Runs a child without a shell; never throws. The action text goes in argv or env, never in code. */
function run(
	file: string,
	args: string[],
	opts: { signal?: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<Run> {
	return new Promise((resolve) => {
		try {
			execFile(
				file,
				args,
				{
					timeout: opts.timeoutMs,
					maxBuffer: 64 * 1024,
					windowsHide: true,
					...(opts.signal ? { signal: opts.signal } : {}),
					...(opts.env ? { env: opts.env } : {}),
				},
				(err, stdout) => {
					const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
					resolve({
						code: e ? (typeof e.code === "number" ? e.code : null) : 0,
						stdout: String(stdout ?? ""),
						aborted:
							opts.signal?.aborted === true ||
							Boolean((e as { killed?: boolean } | null)?.killed),
					});
				},
			);
		} catch {
			resolve({ code: null, stdout: "", aborted: false });
		}
	});
}

/** Keeps the prompt readable: one line, no control characters, bounded. */
export function promptText(text: string, max = 300): string {
	const clean = [...text.replace(/\s+/g, " ")]
		.filter((c) => {
			const n = c.codePointAt(0) ?? 0;
			return n >= 0x20 && n !== 0x7f && !(n >= 0x80 && n < 0xa0);
		})
		.join("")
		.trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// ---------------------------------------------------------------- macOS

/**
 * LocalAuthentication through osascript's JavaScript bridge (JXA): no
 * compiled helper and no npm dependency. Policy 2 is
 * LAPolicyDeviceOwnerAuthentication: Touch ID or Apple Watch, with the login
 * password as the fallback. argv[0] is the reason, argv[1] the timeout (ms),
 * argv[2] "probe" for the no-UI availability check. The reply block fires on
 * another queue; the main thread spins the run loop until it does. Prints
 * one JSON line: {ok, code}.
 */
export const MAC_SCRIPT = `ObjC.import('LocalAuthentication');
ObjC.import('Foundation');
function run(argv) {
  var ctx = $.LAContext.alloc.init;
  var err = Ref();
  if (!ctx.canEvaluatePolicyError(2, err)) {
    var c = err[0] && !err[0].isNil() ? Number(err[0].code) : -1000;
    return JSON.stringify({ ok: false, code: c, probe: true });
  }
  if (argv[2] === 'probe') return JSON.stringify({ ok: true, probe: true });
  ctx.localizedCancelTitle = 'Deny';
  var out = { ok: false, code: null };
  var done = false;
  ctx.evaluatePolicyLocalizedReasonReply(2, argv[0], function (ok, e) {
    out.ok = !!ok;
    out.code = e && !e.isNil() ? Number(e.code) : null;
    done = true;
  });
  var deadline = Date.now() + Number(argv[1] || 120000);
  while (!done && Date.now() < deadline)
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  if (!done) {
    ctx.invalidate;
    return JSON.stringify({ ok: false, code: -9, timeout: true });
  }
  return JSON.stringify(out);
}`;

const OSASCRIPT = "/usr/bin/osascript";

/** LAError codes to outcomes. Only the person's own cancel or failure is a denial. */
export function macOutcome(r: {
	ok?: boolean;
	code?: number | null;
	timeout?: boolean;
}): PresenceOutcome {
	if (r.ok) return "granted";
	if (r.timeout) return "timeout";
	switch (r.code) {
		case -1: // authenticationFailed
		case -2: // userCancel ("Deny")
			return "denied";
		case -9: // appCancel (invalidated: our timeout)
			return "timeout";
		default:
			// -4 systemCancel, -5 passcodeNotSet, -6/-7/-8 biometry, -1004 notInteractive, …
			return "unavailable";
	}
}

function parse(stdout: string): Record<string, unknown> | null {
	try {
		const line = stdout.trim().split("\n").at(-1) ?? "";
		const v = JSON.parse(line);
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

const macProvider: PresenceProvider = {
	method: "Touch ID",
	async available() {
		const r = await run(
			OSASCRIPT,
			["-l", "JavaScript", "-e", MAC_SCRIPT, "", "0", "probe"],
			{ timeoutMs: 5000 },
		);
		return parse(r.stdout)?.ok === true;
	},
	async verify(reason, { signal, timeoutMs }) {
		const r = await run(
			OSASCRIPT,
			[
				"-l",
				"JavaScript",
				"-e",
				MAC_SCRIPT,
				promptText(reason),
				String(timeoutMs),
			],
			{ signal, timeoutMs: timeoutMs + 5000 },
		);
		if (r.aborted) return "timeout";
		const v = parse(r.stdout);
		if (!v) return "unavailable";
		return macOutcome(v as { ok?: boolean; code?: number; timeout?: boolean });
	},
};

// ---------------------------------------------------------------- Windows

/**
 * Windows Hello through WinRT's UserConsentVerifier, from Windows
 * PowerShell 5 (it ships with Windows and can await WinRT operations). The
 * reason comes in through the environment, never through the script text.
 * Prints one word: Available/… for the probe, Verified/Canceled/… after.
 */
const WIN_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait() | Out-Null; $t.Result }
$v = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$a = Await ($v::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($env:PULSAR_PRESENCE_PROBE -eq '1' -or "$a" -ne 'Available') { Write-Output "$a"; exit 0 }
$r = Await ($v::RequestVerificationAsync($env:PULSAR_PRESENCE_REASON)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "$r"`;

export function windowsOutcome(word: string): PresenceOutcome {
	switch (word.trim()) {
		case "Verified":
			return "granted";
		case "Canceled":
		case "RetriesExhausted":
			return "denied";
		default:
			// DeviceNotPresent, NotConfiguredForUser, DisabledByPolicy, DeviceBusy, Available (probe)
			return "unavailable";
	}
}

function powershell(
	reason: string,
	probe: boolean,
	opts: { signal?: AbortSignal; timeoutMs: number },
) {
	return run(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT],
		{
			...opts,
			env: {
				...process.env,
				PULSAR_PRESENCE_REASON: reason,
				PULSAR_PRESENCE_PROBE: probe ? "1" : "0",
			},
		},
	);
}

const windowsProvider: PresenceProvider = {
	method: "Windows Hello",
	async available() {
		const r = await powershell("", true, { timeoutMs: 10_000 });
		return r.stdout.trim().split(/\s+/).at(-1) === "Available";
	},
	async verify(reason, { signal, timeoutMs }) {
		const r = await powershell(promptText(reason), false, {
			signal,
			timeoutMs,
		});
		if (r.aborted) return "timeout";
		return windowsOutcome(r.stdout.trim().split(/\s+/).at(-1) ?? "");
	},
};

// ---------------------------------------------------------------- Linux

/**
 * polkit, with Pulsar's own action (docs/presence.md has the policy file;
 * installing it needs root, so `pulsar setup` doesn't). Without it, polkit
 * would show a stock "run as the super user" message that doesn't name the
 * action, so Linux uses the app instead. Needs a graphical session (a polkit
 * agent to show the dialog); never over SSH.
 */
const POLKIT_ACTION = "dev.pulsar.confirm";

export function polkitOutcome(code: number | null): PresenceOutcome {
	// pkcheck: 0 authorized, 1 not authorized, 3 dismissed, 2 challenge, 4 error.
	if (code === 0) return "granted";
	if (code === 1 || code === 3) return "denied";
	return "unavailable";
}

const linuxProvider: PresenceProvider = {
	method: "polkit",
	async available() {
		if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
		if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
		const r = await run("pkaction", ["--action-id", POLKIT_ACTION], {
			timeoutMs: 5000,
		});
		return r.code === 0;
	},
	async verify(reason, { signal, timeoutMs }) {
		const r = await run(
			"pkcheck",
			[
				"--action-id",
				POLKIT_ACTION,
				"--process",
				String(process.pid),
				"--allow-user-interaction",
				"--detail",
				"action",
				promptText(reason),
			],
			{ signal, timeoutMs },
		);
		if (r.aborted) return "timeout";
		return polkitOutcome(r.code);
	},
};

/**
 * This platform's provider, or null. `PULSAR_NATIVE_PRESENCE=off` turns it
 * off (tests set it so no test ever shows a real prompt). Nothing in the
 * environment can turn a prompt into a "granted": a switch only removes a way
 * to ask.
 */
export function nativeProvider(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): PresenceProvider | null {
	if (env.PULSAR_NATIVE_PRESENCE === "off") return null;
	if (platform === "darwin") return macProvider;
	if (platform === "win32") return windowsProvider;
	if (platform === "linux") return linuxProvider;
	return null;
}
