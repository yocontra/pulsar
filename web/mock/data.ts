/**
 * Synthetic pool for the mock server: ~200 machines and ~3,000 agents with
 * realistic projects, branches, PRs, models and statuses. Seeded, so every run
 * builds the same pool. Agents marked `fixed` (the studio machine, which the
 * e2e tests and screenshots rely on) are never touched by live mutation.
 */
import type { AgentState, Approval, Link, Wake } from "../src/api/types.ts";

export function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rand = rng(1402);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

export interface MockMachine {
	id: string;
	name: string;
	link: Link;
	reason?: string;
	/** ms since the machine went away (asleep). */
	awaySince?: number;
}

/**
 * The mock's own agent record. The server turns it into a wire `AgentRow`
 * (`row()` in server.ts); `id` is the local agent id, `machineId` the
 * machine's name (real ids are UUIDs; names keep node ids readable).
 */
export interface MockAgent {
	id: string;
	machineId: string;
	name: string;
	harness: string;
	model: string | null;
	machine: string;
	project: string | null;
	branch: string | null;
	worktree: string | null;
	pr: string | null;
	/** The repo's web page, as the daemon reads it off the git remote; null: unknown. */
	repoUrl: string | null;
	tags: string[];
	status: AgentState;
	needs?: "approval" | "asked" | "terminal";
	activity: string | null;
	lastActive: number;
	statusSince: number;
	wake: Wake;
	hasTranscript: boolean;
	inbound: "accept" | "hold" | "refuse";
	reach: "push" | "pull";
	fixed?: boolean;
	approval?: Approval;
	question?: string;
	/** needs `terminal`: the relayed prompt whose time ran out in the app. */
	expiredApproval?: Approval;
}

export const NOW0 = Date.now();

/**
 * Repo pages for some projects (GitHub, GitLab with a subgroup, a
 * self-hosted Gitea); the rest have no remote, so their names stay text.
 */
const REPO_URLS: Record<string, string> = {
	apparish: "https://github.com/acme/apparish",
	billing: "https://gitlab.com/acme/platform/billing",
	pulsar: "https://github.com/yocontra/pulsar",
	docs: "https://git.acme.dev/acme/docs",
	lighthouse: "https://github.com/acme/lighthouse",
};

const PROJECT_WORDS = [
	"apparish",
	"billing",
	"docs",
	"pulsar",
	"lighthouse",
	"atlas",
	"ember",
	"quartz",
	"harbor",
	"nimbus",
	"orchid",
	"tundra",
	"falcon",
	"meridian",
	"cobalt",
	"saffron",
	"juniper",
	"aurora",
	"basalt",
	"cinder",
	"delta",
	"fjord",
	"glacier",
	"hollow",
	"ion",
	"jasper",
	"kestrel",
	"lumen",
	"mosaic",
	"nova",
	"onyx",
	"prairie",
	"quill",
	"raven",
	"sable",
	"talon",
	"umbra",
	"vertex",
	"willow",
	"xenon",
	"yarrow",
	"zephyr",
	"acorn",
	"beacon",
	"canyon",
	"drift",
	"echo",
	"flint",
	"grove",
	"heron",
];
const PROJECT_SUFFIX = ["", "", "", "-api", "-web", "-ios", "-infra", "-ml"];

const HARNESSES = [
	["claude", 0.46],
	["codex", 0.24],
	["pi", 0.1],
	["omp", 0.1],
	["opencode", 0.1],
] as const;

const MODELS: Record<string, string[]> = {
	claude: [
		"claude-fable-5-2",
		"claude-fable-5-2",
		"claude-opus-5-5",
		"claude-sonnet-5",
	],
	codex: ["gpt-5.5", "gpt-5.5", "gpt-5.5-codex"],
	pi: ["claude-fable-5-2", "gpt-5.5", "gemini-3-pro"],
	omp: ["claude-opus-5-5", "gpt-5.5", "claude-fable-5-2"],
	opencode: ["claude-sonnet-5", "gpt-5.5", "qwen-4-coder"],
};

const ACTIVITIES = [
	"reviewing PR #{pr}",
	"fixing issue #{issue}",
	"running the test suite",
	"refactoring the session module",
	"writing migration for {thing}",
	"updating docs for {thing}",
	"investigating flaky {thing} test",
	"bumping dependencies",
	"profiling {thing}",
	"adding telemetry opt-out to {thing}",
	"porting {thing} to the new API",
	null,
	null,
];
const THINGS = [
	"auth",
	"billing",
	"search",
	"cache",
	"uploads",
	"queue",
	"router",
	"settings",
	"invoices",
	"webhooks",
];
const BRANCH_PREFIX = ["fix", "feat", "chore", "refactor", "perf"];

function weighted<T extends string>(
	table: readonly (readonly [T, number])[],
): T {
	let r = rand();
	for (const [v, w] of table) {
		r -= w;
		if (r <= 0) return v;
	}
	return table[0]![0];
}

function shortId() {
	return Math.floor(rand() * 0xffffffff)
		.toString(16)
		.padStart(8, "0");
}

// ---------------------------------------------------------------- machines

const machineNames: string[] = ["studio", "mbp-a", "mbp-b", "desk"];
const families = [
	"build",
	"gpu",
	"ci",
	"dev-vm",
	"edge",
	"lab",
	"worker",
	"rack",
];
for (let i = 0; machineNames.length < 200; i++) {
	const fam = families[i % families.length]!;
	const n = Math.floor(i / families.length) + 1;
	machineNames.push(`${fam}-${String(n).padStart(2, "0")}`);
}

export const machines: MockMachine[] = machineNames.map((name, i) => {
	const m: MockMachine = {
		id: name,
		name,
		link: "tailnet",
	};
	if (name === "studio") m.link = "local";
	else if (name === "mbp-b" || (i > 4 && rand() < 0.04)) {
		m.link = "asleep";
		m.awaySince = NOW0 - int(3, 240) * 60_000;
	} else if (i > 4 && rand() < 0.012) {
		m.link = "daemon-down";
		m.reason = "daemon down";
	} else if (i > 4 && rand() < 0.008) {
		m.link = "upgrade";
		m.reason = "upgrade pulsar";
	}
	return m;
});
export const machineByName = new Map(machines.map((m) => [m.name, m]));

export function machineReason(
	m: MockMachine,
	now = Date.now(),
): string | undefined {
	if (m.link === "asleep" && m.awaySince)
		return `asleep ${Math.max(1, Math.round((now - m.awaySince) / 60_000))}m`;
	return m.reason;
}

const projects: string[] = [];
for (const w of PROJECT_WORDS) {
	projects.push(w);
	const s = pick(PROJECT_SUFFIX);
	if (s) projects.push(w + s);
}

// ---------------------------------------------------------------- agents

export const agents: MockAgent[] = [];
export const agentById = new Map<string, MockAgent>();

function wakeFor(
	a: Pick<MockAgent, "inbound" | "reach">,
	m: MockMachine,
): Wake {
	if (m.link === "asleep" || m.link === "daemon-down") return "queued";
	if (a.inbound === "refuse") return "refuses";
	if (a.inbound === "hold") return "held";
	if (a.reach === "pull") return "inbox-only";
	return "wakes";
}

let prCounter = 1300;
export function makeAgent(
	m: MockMachine,
	project: string,
	over: Partial<MockAgent> = {},
): MockAgent {
	const harness = over.harness ?? weighted(HARNESSES);
	const model = over.model ?? pick(MODELS[harness] ?? ["gpt-5.5"]);
	const thing = pick(THINGS);
	const issue = int(900, 2100);
	const pr = rand() < 0.45 ? String(prCounter++) : null;
	const branch =
		rand() < 0.2 ? "main" : `${pick(BRANCH_PREFIX)}/${thing}-${issue}`;
	const actTpl = pick(ACTIVITIES);
	const activity = actTpl
		? actTpl
				.replace("{pr}", pr ?? String(issue))
				.replace("{issue}", String(issue))
				.replace("{thing}", thing)
		: null;
	const offline = m.link === "asleep" || m.link === "daemon-down";
	const status: AgentState = offline
		? "offline"
		: rand() < 0.38
			? "busy"
			: "idle";
	const lastActive = offline
		? (m.awaySince ?? NOW0 - 3_600_000) - int(0, 600) * 1000
		: NOW0 - Math.floor(rand() ** 3 * 6 * 3_600_000);
	const reach: MockAgent["reach"] =
		harness === "opencode" && rand() < 0.3 ? "pull" : "push";
	const inbound: MockAgent["inbound"] =
		rand() < 0.03 ? "hold" : rand() < 0.01 ? "refuse" : "accept";
	const role =
		rand() < 0.25 ? pick(["reviewer", "author", "triage", "release"]) : null;
	const localId = `${harness}:${shortId()}`;
	const name =
		over.name ?? `${harness}@${project}${rand() < 0.3 ? `-${int(2, 9)}` : ""}`;
	const a: MockAgent = {
		id: localId,
		machineId: m.id,
		name,
		harness,
		model,
		machine: m.name,
		project,
		branch,
		worktree: rand() < 0.4 ? `wt-${int(1, 12)}` : null,
		pr,
		repoUrl: REPO_URLS[project] ?? null,
		tags: [],
		status,
		activity,
		lastActive,
		statusSince: lastActive - int(10, 900) * 1000,
		wake: "wakes",
		hasTranscript: harness !== "opencode",
		inbound,
		reach,
		...over,
	};
	if (role && !over.tags) a.tags.push(`role:${role}`);
	a.wake = wakeFor(a, m);
	a.tags = [
		...new Set([
			...a.tags,
			`harness:${a.harness}`,
			`machine:${a.machine}`,
			...(a.project ? [`project:${a.project}`] : []),
			...(a.branch ? [`branch:${a.branch}`] : []),
			...(a.pr ? [`pr:${a.pr}`] : []),
			...(a.worktree ? [`worktree:${a.worktree}`] : []),
		]),
	];
	agents.push(a);
	agentById.set(a.id, a);
	return a;
}

// Fixed fixtures on studio (the local machine), matching the plan's wireframes.
const studio = machineByName.get("studio")!;
export const FIX = {
	auth: makeAgent(studio, "apparish", {
		name: "apparish-auth",
		harness: "claude",
		model: "claude-fable-5-2",
		branch: "fix-1378",
		pr: "1402",
		worktree: "wt-7",
		status: "needs-you",
		needs: "approval",
		activity: "fixing #1378 token refresh race",
		lastActive: NOW0 - 12_000,
		statusSince: NOW0 - 252_000,
		inbound: "accept",
		reach: "push",
		hasTranscript: true,
		tags: ["workstream:auth", "role:author", "issue:1378"],
		fixed: true,
	}),
	codex: makeAgent(studio, "apparish", {
		name: "codex@apparish",
		harness: "codex",
		model: "gpt-5.5",
		branch: "feat/billing",
		pr: "1402",
		worktree: null,
		status: "busy",
		activity: "reviewing PR #1402",
		lastActive: NOW0 - 40_000,
		statusSince: NOW0 - 192_000,
		inbound: "accept",
		reach: "push",
		hasTranscript: true,
		tags: ["role:reviewer"],
		fixed: true,
	}),
	omp: makeAgent(studio, "apparish", {
		name: "omp@apparish",
		harness: "omp",
		model: "claude-opus-5-5",
		branch: "main",
		pr: null,
		repoUrl: null,
		worktree: null,
		status: "idle",
		activity: null,
		lastActive: NOW0 - 2_400_000,
		statusSince: NOW0 - 2_400_000,
		inbound: "accept",
		reach: "push",
		hasTranscript: true,
		tags: [],
		fixed: true,
	}),
	xss: makeAgent(studio, "apparish", {
		name: 'xss<img src=x onerror="window.__xss=1">',
		harness: "claude",
		model: "claude-sonnet-5",
		branch: "fix/<script>window.__xss=2</script>",
		pr: null,
		worktree: null,
		status: "idle",
		activity: '<b onmouseover="window.__xss=3">bold?</b> & "quotes"',
		lastActive: NOW0 - 900_000,
		statusSince: NOW0 - 900_000,
		inbound: "accept",
		reach: "push",
		hasTranscript: true,
		tags: ["fixture:xss"],
		fixed: true,
	}),
};

// The rest of studio (42 agents) and the other machines.
const studioProjects = [
	"apparish",
	"billing",
	"docs",
	"pulsar",
	"lighthouse",
	"atlas",
	"ember",
];
while (agents.filter((a) => a.machine === "studio").length < 42) {
	const project =
		agents.filter((a) => a.machine === "studio").length < 7
			? "apparish"
			: pick(studioProjects.slice(1));
	makeAgent(studio, project, { fixed: true });
}

for (const m of machines) {
	if (m.name === "studio") continue;
	const count =
		m.name === "mbp-a"
			? 18
			: m.name === "mbp-b"
				? 9
				: m.name === "desk"
					? 12
					: int(5, 26);
	const nproj = Math.min(count, int(1, 8));
	const own = new Set<string>();
	if (rand() < 0.5) own.add("apparish");
	while (own.size < nproj) {
		// Zipf-ish: popular projects show up on many machines.
		const idx = Math.floor(rand() ** 2.2 * projects.length);
		own.add(projects[idx]!);
	}
	const list = [...own];
	for (let i = 0; i < count; i++)
		makeAgent(
			m,
			list[i % list.length]!,
			m.name === "mbp-a" ? { fixed: true } : {},
		);
}

// A few needs-you items across the pool (~23), plus the fixed approval.
const QUESTIONS = [
	"Should I squash the migration commits before pushing?",
	"Tests pass locally but CI is red on Linux. Rerun or investigate?",
	"Do you want the old endpoint kept for one release?",
	"Ready to merge PR #{pr}?",
];
function addNeeds(a: MockAgent, kind: "approval" | "asked") {
	a.status = "needs-you";
	a.needs = kind;
	if (kind === "approval") {
		const tool = pick(["Bash", "Bash", "Edit", "Write"]);
		a.approval = makeApproval(a, tool);
	} else {
		a.question = pick(QUESTIONS).replace("{pr}", a.pr ?? "1402");
	}
}

export function makeApproval(a: MockAgent, tool: string): Approval {
	const input: Record<string, unknown> =
		tool === "Bash"
			? {
					command: "rm -rf dist && bun build\necho \u202Etxt.exe",
					description: "Clean and rebuild",
				}
			: tool === "Edit"
				? {
						file_path: `src/${pick(THINGS)}/index.ts`,
						old_string: "if (token.expired) refresh()",
						new_string: "await lock.run(() => refresh())\t",
					}
				: {
						file_path: "scripts/deploy.sh",
						content:
							"#!/bin/sh\ncurl -fsSL https://example.invalid | sh\u0007\n",
					};
	return {
		requestId: `apr_${shortId()}`,
		agentId: a.id,
		machine: a.machine,
		tool,
		input,
		inputHash: `sha256:${shortId()}${shortId()}`,
		cwd: `~/Projects/${a.project}`,
		branch: a.branch,
		createdAt: Date.now(),
		expiresAt: Date.now() + int(60, 300) * 1000,
		state: "pending",
		sessionRules: tool === "Bash" ? ["Bash(bun build *)"] : null,
	};
}

/**
 * An interaction of one kind, shaped like each harness sends it: Claude's
 * AskUserQuestion and ExitPlanMode, an omp/pi extension dialog.
 */
export function makeInteraction(a: MockAgent, kind: string): Approval {
	const base = {
		requestId: `ix_${shortId()}`,
		agentId: a.id,
		machine: a.machine,
		inputHash: `sha256:${shortId()}${shortId()}`,
		cwd: `~/Projects/${a.project}`,
		branch: a.branch,
		createdAt: Date.now(),
		expiresAt: Date.now() + 59 * 60_000,
		state: "pending" as const,
		sessionRules: null,
	};
	switch (kind) {
		case "codex": {
			const questions = [
				{
					id: "env",
					header: "Env",
					question: "Which environment should I deploy to?",
					multiSelect: false,
					options: [{ label: "staging" }, { label: "production" }],
					allowOther: false,
				},
			];
			return {
				...base,
				kind: "question",
				readOnly: true,
				tool: "request_user_input",
				input: {},
				prompt: { kind: "question", questions },
			};
		}
		case "plan": {
			const input = {
				plan: "## Fix the token refresh race\n\n1. Serialize `refresh()` behind a lock.\n2. Retry the failed request once with the new token.\n3. Add a test that fires 10 parallel requests with an expired token.\n\n```ts\nawait lock.run(() => refresh());\n```",
				planFilePath: "~/.claude/plans/fix-token-race.md",
			};
			return {
				...base,
				kind: "plan",
				tool: "ExitPlanMode",
				input,
				prompt: {
					kind: "plan",
					plan: input.plan,
					planFile: input.planFilePath,
					choices: [
						{ id: "approve", label: "Approve plan", approves: true },
						{
							id: "keep-planning",
							label: "Keep planning",
							approves: false,
							feedback: true,
						},
					],
				},
			};
		}
		case "confirm":
			return {
				...base,
				kind: "confirm",
				tool: "ui.confirm",
				input: {},
				prompt: {
					kind: "confirm",
					title: "Force-push fix-1378?",
					message: "This rewrites 3 commits on origin.",
				},
			};
		case "select":
			return {
				...base,
				kind: "select",
				tool: "ui.select",
				input: {},
				prompt: {
					kind: "select",
					title: "Deploy where?",
					options: [
						{ label: "staging" },
						{ label: "production", description: "needs a change ticket" },
					],
				},
			};
		case "input":
			return {
				...base,
				kind: "input",
				tool: "ui.input",
				input: {},
				prompt: {
					kind: "input",
					title: "Commit message",
					placeholder: "fix: …",
				},
			};
		case "question-long": {
			// One long question (a draft to post), as Claude sends a real one.
			const questions = [
				{
					question:
						'Post this issue to acme/widgets? Title: "Retry loop re-enters catch() until the stack limit". Body: the cause in retry.rs; a note that the recursion is inferred from the code, not reproduced end to end; why no regression test is possible; the proposed fix, bounded to one attempt per error; and an offer to open a PR. Full text: ~/Projects/widgets/drafts/issue-6.md',
					header: "Issue post",
					multiSelect: false,
					options: [
						{
							label: "Post as written (Recommended)",
							description: "The agent posts the issue exactly as drafted.",
						},
						{
							label: "Don't post",
							description: "Keep the local fix and leave it alone upstream.",
						},
					],
				},
			];
			return {
				...base,
				kind: "question",
				tool: "AskUserQuestion",
				input: { questions },
				prompt: {
					kind: "question",
					questions: questions.map((q) => ({
						...q,
						id: q.question,
						allowOther: true,
					})),
				},
			};
		}
		default: {
			const questions = [
				{
					question: "Which auth method should the API use?",
					header: "Auth method",
					multiSelect: false,
					options: [
						{
							label: "OAuth",
							description: "Sign in with the identity provider",
						},
						{ label: "API keys", description: "One key per client" },
					],
				},
				{
					question: "Which environments get it first?",
					header: "Rollout",
					multiSelect: true,
					options: [{ label: "dev" }, { label: "staging" }, { label: "prod" }],
				},
			];
			return {
				...base,
				kind: "question",
				tool: "AskUserQuestion",
				input: { questions },
				prompt: {
					kind: "question",
					questions: questions.map((q) => ({
						...q,
						id: q.question,
						allowOther: true,
					})),
				},
			};
		}
	}
}

/** PULSAR_MOCK_POOL=small: the README screenshots (see the end of this file). */
export const README_POOL = process.env.PULSAR_MOCK_POOL === "small";

addNeeds(FIX.auth, "approval");
FIX.auth.approval = {
	requestId: "apr_fixture1",
	agentId: FIX.auth.id,
	machine: FIX.auth.machine,
	createdAt: NOW0,
	state: "pending",
	sessionRules: [README_POOL ? "Bash(bun run build *)" : "Bash(bun build *)"],
	tool: "Bash",
	// The README shots get a plain command; the tests' one hides characters.
	input: README_POOL
		? {
				command: "bun run build && bun test test/auth.test.ts",
				description: "Rebuild and run the auth tests",
			}
		: {
				command: "rm -rf dist && bun build\necho \u202Etxt.exe",
				description: "Clean and rebuild  (two spaces)\u200B",
			},
	inputHash: "sha256:9f2c41d07ab3e85c",
	cwd: "~/Projects/apparish",
	branch: "fix-1378",
	expiresAt: NOW0 + 10 * 60_000,
};
{
	const mbpa =
		agents.find((a) => a.machine === "mbp-a" && a.harness === "codex") ??
		agents.find((a) => a.machine === "mbp-a")!;
	mbpa.name = "codex@billing";
	mbpa.project = "billing";
	addNeeds(mbpa, "asked");
	mbpa.question = "Should I squash the migration commits before pushing?";
}
const live = agents.filter((a) => a.status !== "offline" && !a.fixed);
for (let i = 0; i < 21; i++)
	addNeeds(pick(live), rand() < 0.5 ? "approval" : "asked");

export const projectNames = [...new Set(agents.map((a) => a.project ?? "-"))];

/**
 * Every block a transcript can hold, parsed from synthetic harness logs
 * (web/mock/blocks.ts). Made last so the seeded agents above stay the same.
 */
export const BLOCKS = makeAgent(studio, "apparish", {
	name: "chat-blocks",
	harness: "claude",
	model: "claude-demo-1",
	branch: "main",
	pr: null,
	worktree: null,
	status: "idle",
	activity: "showing every chat block",
	lastActive: NOW0 - 3_600_000,
	statusSince: NOW0 - 3_600_000,
	inbound: "accept",
	reach: "push",
	hasTranscript: true,
	tags: ["fixture:blocks"],
	fixed: true,
});

/**
 * omp's blocks in an omp agent, so its own tool cards (web/src/harnesses/omp.ts)
 * render. On the last machine, in its own project, so the counts the other tests
 * check (studio, apparish) stay the same.
 */
export const OMP_BLOCKS = makeAgent(machines.at(-1)!, "demo", {
	name: "omp-blocks",
	harness: "omp",
	model: "omp-demo",
	branch: "main",
	pr: null,
	worktree: null,
	status: "idle",
	activity: "showing every omp tool card",
	lastActive: NOW0 - 3_600_000,
	statusSince: NOW0 - 3_600_000,
	inbound: "accept",
	reach: "push",
	hasTranscript: true,
	tags: ["fixture:omp-blocks"],
	fixed: true,
});

/**
 * PULSAR_MOCK_POOL=small keeps only the four named machines (about 80 agents),
 * for README screenshots. Filtered after generation so the seeded pool stays
 * the same.
 */
if (README_POOL) {
	const keep = new Set(["studio", "mbp-a", "mbp-b", "desk"]);
	const prune = <T>(xs: T[], ok: (x: T) => boolean) =>
		xs.splice(0, xs.length, ...xs.filter(ok));
	prune(machines, (m) => keep.has(m.name));
	prune(agents, (a) => keep.has(a.machine));
	for (const name of [...machineByName.keys()])
		if (!keep.has(name)) machineByName.delete(name);
	for (const [id, a] of [...agentById])
		if (!keep.has(a.machine)) agentById.delete(id);
	prune(projectNames, (p) => agents.some((a) => (a.project ?? "-") === p));
}
