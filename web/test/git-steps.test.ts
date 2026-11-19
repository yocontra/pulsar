/**
 * The git actions' step loop (web/src/features/git/steps.ts): params per
 * step, the confirms, the pause before each later passkey prompt on
 * another machine (and after a refused one), and how a run ends.
 */
import { describe, expect, test } from "bun:test";
import type { Step } from "../src/features/git/model.ts";
import {
	type Failure,
	type Phase,
	runSteps,
	type StepDeps,
} from "../src/features/git/steps.ts";

class Refused extends Error {
	override name = "NotAllowedError";
}
class Coded extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

const RESULT: Record<Step, unknown> = {
	commit: { sha: "abc1234", branch: "feat", subject: "m", files: 1 },
	push: {
		branch: "feat",
		remote: "origin",
		upstream: "origin/feat",
		pushed: true,
	},
	pr: {
		pr: { number: 9, url: "https://github.com/a/b/pull/9" },
		created: true,
	},
};

/** A fake run: `fail` maps a call number to the error it throws. */
function harness(
	over: Partial<StepDeps> = {},
	fail: Record<number, Error> = {},
	taps: boolean[] = [],
) {
	const calls: { step: Step; params: object }[] = [];
	const phases: Phase[] = [];
	const asked: string[] = [];
	const failures: Failure[] = [];
	const deps: StepDeps = {
		remote: false,
		working: false,
		status: { onDefault: false, branch: "feat", defaultBranch: "main" },
		act: async (step, params) => {
			calls.push({ step, params });
			const e = fail[calls.length];
			if (e) throw e;
			return RESULT[step];
		},
		classify: (e) =>
			e instanceof Refused
				? "not_allowed"
				: e instanceof Coded
					? (e.code as Failure)
					: "other",
		askBusy: async (w) => {
			asked.push(`busy:${w}`);
			return true;
		},
		askDefault: async (b) => {
			asked.push(`default:${b}`);
			return true;
		},
		waitTap: async (p) => {
			phases.push(p);
			return taps.shift() ?? true;
		},
		needsTap: false,
		progress: (p) => phases.push(p),
		refresh: () => {},
		live: () => true,
		failed: (_e, f) => failures.push(f),
		now: () => 0,
		...over,
	};
	return { deps, calls, phases, asked, failures };
}

const COMMIT = { files: ["a.ts"], message: "m" };

describe("runSteps", () => {
	test("commit → push → PR here: params per step, the last result", async () => {
		const h = harness();
		const end = await runSteps(["commit", "push", "pr"], COMMIT, h.deps);
		expect(h.calls).toEqual([
			{ step: "commit", params: { files: ["a.ts"], message: "m" } },
			{ step: "push", params: {} },
			{ step: "pr", params: {} },
		]);
		expect(end).toEqual({
			kind: "done",
			text: "Created PR #9",
			href: "https://github.com/a/b/pull/9",
		});
		expect(h.phases.filter((p) => p.kind === "paused")).toEqual([]);
	});

	test("a working agent: one confirm, carried by commit and push", async () => {
		const h = harness({ working: true });
		await runSteps(["commit", "push"], COMMIT, h.deps);
		expect(h.asked).toEqual(["busy:Commit"]);
		expect(h.calls.map((c) => c.params)).toEqual([
			{ files: ["a.ts"], message: "m", confirmBusy: true },
			{ confirmBusy: true },
		]);
		// Declined: nothing runs.
		const no = harness({ working: true, askBusy: async () => false });
		expect(await runSteps(["push"], undefined, no.deps)).toEqual({
			kind: "idle",
		});
		expect(no.calls).toEqual([]);
	});

	test("a push on the default branch asks, then says so in its params", async () => {
		const h = harness({
			status: { onDefault: true, branch: "main", defaultBranch: "main" },
		});
		await runSteps(["push"], undefined, h.deps);
		expect(h.asked).toEqual(["default:main"]);
		expect(h.calls[0]!.params).toEqual({ confirmDefault: true });
	});

	test("a commit on the default branch drops the PR step", async () => {
		const h = harness();
		h.deps.act = async (step, params) => {
			h.calls.push({ step, params });
			return step === "commit"
				? { ...(RESULT.commit as object), branch: "main" }
				: RESULT[step];
		};
		const end = await runSteps(
			["commit", "push", "pr"],
			{
				...COMMIT,
				confirmDefault: true,
			},
			h.deps,
		);
		expect(h.calls.map((c) => c.step)).toEqual(["commit", "push"]);
		expect(end).toMatchObject({ text: "Pushed to origin/feat" });
	});

	test("another machine on iOS: a tap before each later step", async () => {
		const h = harness({ remote: true, needsTap: true });
		const end = await runSteps(["commit", "push", "pr"], COMMIT, h.deps);
		expect(
			h.phases
				.filter((p) => p.kind === "paused")
				.map((p) => (p as { step: Step }).step),
		).toEqual(["push", "pr"]);
		expect(h.calls.map((c) => c.step)).toEqual(["commit", "push", "pr"]);
		expect(end).toMatchObject({ text: "Created PR #9" });
	});

	test("Stop at a tap keeps the last result and runs nothing more", async () => {
		const h = harness({ remote: true, needsTap: true }, {}, [false]);
		const end = await runSteps(["commit", "push", "pr"], COMMIT, h.deps);
		expect(h.calls.map((c) => c.step)).toEqual(["commit"]);
		expect(end).toEqual({ kind: "done", text: "Committed abc1234" });
	});

	test("a refused prompt on step 2 pauses; the tap retries it", async () => {
		const h = harness({ remote: true }, { 2: new Refused("no gesture") });
		const end = await runSteps(["commit", "push", "pr"], COMMIT, h.deps);
		const paused = h.phases.filter((p) => p.kind === "paused");
		expect(paused).toEqual([
			{ kind: "paused", step: "push", index: 1, total: 3 },
		]);
		expect(h.calls.map((c) => c.step)).toEqual([
			"commit",
			"push",
			"push",
			"pr",
		]);
		expect(end).toMatchObject({ text: "Created PR #9" });
		// On the first step (a tap started it), a refusal ends the run.
		const first = harness({ remote: true }, { 1: new Refused("cancel") });
		expect(await runSteps(["push", "pr"], undefined, first.deps)).toEqual({
			kind: "idle",
		});
		expect(first.failures).toEqual(["not_allowed"]);
	});

	test("the daemon's confirm (a race) asks, then retries with the flag", async () => {
		const h = harness({}, { 1: new Coded("confirm_busy") });
		await runSteps(["commit"], COMMIT, h.deps);
		expect(h.asked).toEqual(["busy:Commit"]);
		expect(h.calls.map((c) => c.params)).toEqual([
			{ files: ["a.ts"], message: "m" },
			{ files: ["a.ts"], message: "m", confirmBusy: true },
		]);
		const d = harness({}, { 1: new Coded("confirm_default") });
		await runSteps(["push"], undefined, d.deps);
		expect(d.calls.map((c) => c.params)).toEqual([
			{},
			{ confirmDefault: true },
		]);
	});

	test("a failure ends the run: the notice, then the button again", async () => {
		const h = harness({}, { 2: new Error("Push rejected") });
		const end = await runSteps(["commit", "push", "pr"], COMMIT, h.deps);
		expect(h.failures).toEqual(["other"]);
		expect(h.calls.map((c) => c.step)).toEqual(["commit", "push"]);
		expect(end).toEqual({ kind: "idle" });
		// Prove Human cancelled: quiet.
		const c = harness({}, { 1: new Coded("cancelled") });
		expect(await runSteps(["push"], undefined, c.deps)).toEqual({
			kind: "idle",
		});
		expect(c.failures).toEqual([]);
	});
});
