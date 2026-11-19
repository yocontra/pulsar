import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, isPane, paneOf, panePid, sendKeys } from "../src/tmux.ts";
import type { Agent } from "../src/types.ts";

/**
 * src/tmux.ts against a private tmux server (`tmux -L <name>` in a temp
 * TMUX_TMPDIR, no config file): never the user's tmux. Skipped without tmux.
 */

const HAS_TMUX = Boolean(Bun.which("tmux"));
const SOCKET = `pulsar-test-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "pulsar-tmux-"));
const opts = { socket: SOCKET };
const out = join(dir, "got.txt");
let pane = "";

function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", SOCKET, ...args], {
		encoding: "utf8",
		env: { ...process.env, TMUX_TMPDIR: dir },
	});
}

/** Waits (no polling) until the pane's reader took one more line. */
function took(): Promise<void> {
	return new Promise((resolve, reject) =>
		execFile(
			"tmux",
			["-L", SOCKET, "wait-for", "took"],
			{ env: { ...process.env, TMUX_TMPDIR: dir }, timeout: 5000 },
			(e) => (e ? reject(e) : resolve()),
		),
	);
}

/** The lines the pane's reader got, in order. */
const got = () => readFileSync(out, "utf8").split("\n").slice(0, -1);

const agent = (over: Partial<Agent>): Agent =>
	({
		id: "pi:s",
		harness: "pi",
		pid: null,
		meta: {},
		...over,
	}) as Agent;

beforeAll(() => {
	if (!HAS_TMUX) return;
	process.env.TMUX_TMPDIR = dir;
	delete process.env.TMUX;
	writeFileSync(out, "");
	tmux(
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"t",
		"-x",
		"120",
		"-y",
		"20",
		// Reads lines, writes each to a file, then signals `took`.
		`while IFS= read -r l; do printf '%s\\n' "$l" >> '${out}'; tmux -L ${SOCKET} wait-for -S took; done`,
	);
	pane = tmux("display-message", "-p", "-t", "t", "#{pane_id}").trim();
});

afterAll(() => {
	if (HAS_TMUX)
		try {
			tmux("kill-server");
		} catch {}
	rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_TMUX)("tmux helpers (private server)", () => {
	test("text is typed literally; keys are pressed", async () => {
		expect(isPane(pane)).toBe(true);
		// A trailing `;` (tmux's separator), a leading `-`, a key name as text.
		for (const text of ["-n Enter", " a;b;", ";", "héllo ✓\\"])
			expect(await sendKeys(pane, { text }, opts)).toEqual({ ok: true });
		expect(await sendKeys(pane, { keys: ["Enter"] }, opts)).toEqual({
			ok: true,
		});
		await took();
		expect(got()).toEqual(["-n Enter a;b;;héllo ✓\\"]);
		// The terminal echoed it too.
		expect(await capture(pane, opts)).toContain("-n Enter a;b;;héllo ✓\\");
	});

	test("bad key names and bad panes are refused before tmux runs", async () => {
		expect(
			await sendKeys(pane, { keys: ["Enter; kill-server"] }, opts),
		).toEqual({ ok: false, error: "not a tmux key name: Enter; kill-server" });
		expect(await sendKeys(pane, { keys: [] }, opts)).toMatchObject({
			ok: false,
		});
		expect(await sendKeys("t:0", { text: "x" }, opts)).toMatchObject({
			ok: false,
		});
		expect(await capture("-t", opts)).toBeNull();
	});

	test("panePid is the pane's process; a gone pane has none", async () => {
		const pid = await panePid(pane, opts);
		expect(pid).toBe(
			Number(tmux("display-message", "-p", "-t", pane, "#{pane_pid}").trim()),
		);
		expect(await panePid("%99999", opts)).toBeNull();
		expect(await capture("%99999", opts)).toBeNull();
	});

	test("capture keeps scrollback when asked", async () => {
		for (let i = 0; i < 30; i++) {
			await sendKeys(pane, { text: `line-${i}` }, opts);
			await sendKeys(pane, { keys: ["Enter"] }, opts);
			await took();
		}
		expect(got().at(-1)).toBe("line-29");
		const visible = (await capture(pane, opts)) ?? "";
		const more = (await capture(pane, { ...opts, lines: 200 })) ?? "";
		expect(visible).not.toContain("line-0\n");
		expect(more).toContain("line-0\n");
	});
});

describe("paneOf", () => {
	test("agent.meta.tmux first, then the harness", async () => {
		expect(await paneOf(agent({ meta: { tmux: "%12" } }))).toBe("%12");
		// Not a pane id: ignored.
		expect(await paneOf(agent({ meta: { tmux: "work:1" } }))).toBeNull();
		// A harness that does not know (pi), and Claude without a process.
		expect(await paneOf(agent({}))).toBeNull();
		expect(
			await paneOf(agent({ harness: "claude", id: "claude:x", pid: null })),
		).toBeNull();
	});
});
