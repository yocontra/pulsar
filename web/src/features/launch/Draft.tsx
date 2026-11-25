import {
	ArrowUpIcon,
	FolderGitIcon,
	FolderIcon,
	GitBranchIcon,
	Loader2Icon,
	RotateCcwIcon,
	TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ProveCancelled } from "../../api/client.ts";
import type {
	LaunchHarness,
	LaunchOptions,
	LaunchParams,
	LaunchRefs,
	LaunchState,
} from "../../api/types.ts";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "../../components/ai-elements/prompt-input.tsx";
import { HarnessGlyph } from "../../components/ui/agent-avatar.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { AgentStatus } from "../../components/ui/status.tsx";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { hello } from "../../lib/store.ts";
import { Picker, type PickerOption } from "./Picker.tsx";
import {
	HARNESS_LABEL,
	launchError,
	launches,
	launchOptions,
	launchRefs,
	newNonce,
	startLaunch,
	stepText,
} from "./state.ts";
import "./launch.css";

/**
 * A new agent, as a draft in the session view (no wizard): the headline
 * picks the project and machine, the composer's controls the harness and
 * workspace (current checkout or a new worktree from a base branch), and
 * Send starts it with the first message. While it starts, the steps show
 * in place; once it is up, its real session replaces the draft.
 */

/** Short `~` form of a path on that machine. */
function tilde(path: string, home: string | undefined) {
	return home && (path === home || path.startsWith(`${home}/`))
		? `~${path.slice(home.length)}`
		: path;
}

const looksLikePath = (q: string) =>
	q.startsWith("/") || q === "~" || q.startsWith("~/");

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** Seconds since `since`, ticking. */
function useElapsed(since: number | null) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (since === null) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [since]);
	return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

export interface DraftParams {
	machine?: string;
	project?: string;
	cwd?: string;
}

function DraftImpl({
	params,
	mobile,
}: {
	params: DraftParams;
	mobile: boolean;
}) {
	const h = hello.value;
	const [machine, setMachine] = useState(params.machine || h?.machine || "");
	const [machines, setMachines] = useState<string[]>([]);
	const [opts, setOpts] = useState<LaunchOptions | null>(null);
	const [optsError, setOptsError] = useState<string | null>(null);
	const [cwd, setCwd] = useState<string | null>(params.cwd || null);
	const [extraPaths, setExtraPaths] = useState<string[]>([]);
	const [harness, setHarness] = useState<LaunchHarness | null>(null);
	const [workspace, setWorkspace] = useState<"current" | "worktree">("current");
	const [refs, setRefs] = useState<LaunchRefs | null>(null);
	const [refsLoading, setRefsLoading] = useState(false);
	const [refsError, setRefsError] = useState<string | null>(null);
	const [base, setBase] = useState<string | null>(null);
	const [hasText, setHasText] = useState(false);
	const [phase, setPhase] = useState<"idle" | "starting">("idle");
	const [launchId, setLaunchId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const ta = useRef<HTMLTextAreaElement>(null);
	const pending = useRef("");
	const nonce = useRef(newNonce());
	const launch: LaunchState | null = launchId
		? (launches.value.get(launchId) ?? null)
		: null;
	const elapsed = useElapsed(launch ? launch.startedAt : null);

	// Machines: this one and every other with agents.
	useEffect(() => {
		let live = true;
		api
			.facets({ selector: "*", facet: "machine", top: 100 })
			.then((f) => live && setMachines(f.values.map((v) => v.value)))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	// What the machine offers; a project from the link picks its folder.
	useEffect(() => {
		let live = true;
		setOpts(null);
		setOptsError(null);
		launchOptions(machine).then(
			(o) => {
				if (!live) return;
				setOpts(o);
				setHarness((cur) => {
					if (cur && o.harnesses.some((x) => x.id === cur && x.installed))
						return cur;
					return o.harnesses.find((x) => x.installed)?.id ?? cur ?? "claude";
				});
				setCwd((cur) => {
					if (cur) return cur;
					if (params.project) {
						const p =
							o.projects.find((x) => x.name === params.project) ??
							o.projects.find((x) => baseName(x.path) === params.project);
						if (p) return p.path;
					}
					return o.projects[0]?.path ?? null;
				});
			},
			(e: unknown) => live && setOptsError(launchError(e, machine)),
		);
		return () => {
			live = false;
		};
	}, [machine]);

	// Branches, once a worktree is wanted.
	useEffect(() => {
		if (workspace !== "worktree" || !cwd) return;
		let live = true;
		setRefs(null);
		setRefsError(null);
		setRefsLoading(true);
		launchRefs(machine, cwd)
			.then(
				(r) => {
					if (!live) return;
					setRefs(r);
					setBase((b) =>
						b && r.branches.some((x) => x.name === b)
							? b
							: (r.current ?? r.branches[0]?.name ?? null),
					);
				},
				(e: unknown) => live && setRefsError(launchError(e, machine)),
			)
			.finally(() => live && setRefsLoading(false));
		return () => {
			live = false;
		};
	}, [workspace, cwd, machine]);

	// Up: its session replaces the draft. Failed: the text comes back.
	useEffect(() => {
		if (!launch) return;
		if (launch.step === "done" && launch.agentId) {
			navigate({ view: "agent", id: launch.agentId }, { replace: true });
		} else if (launch.step === "failed") {
			setPhase("idle");
			setError(launch.error ?? "Couldn't start the agent");
			restore();
		}
	}, [launch?.step]);

	const restore = () => {
		if (ta.current && !ta.current.value) {
			ta.current.value = pending.current;
			setHasText(!!pending.current.trim());
		}
		nonce.current = newNonce();
	};

	const home = opts?.home;
	const projectOptions: PickerOption[] = useMemo(() => {
		const list = [...(opts?.projects ?? [])].map((p) => ({
			value: p.path,
			label: p.name,
			sub: tilde(p.path, home),
			badge: machine,
		}));
		for (const p of extraPaths)
			if (!list.some((x) => x.value === p))
				list.unshift({
					value: p,
					label: baseName(p),
					sub: tilde(p, home),
					badge: machine,
				});
		return list;
	}, [opts, extraPaths, machine, home]);

	const machineOptions: PickerOption[] = useMemo(() => {
		const names = new Set([h?.machine ?? "", ...machines, machine]);
		names.delete("");
		return [...names].map((m) => ({
			value: m,
			label: m,
			...(m === h?.machine ? { sub: "This machine" } : {}),
		}));
	}, [machines, machine, h?.machine]);

	const harnessOptions: PickerOption[] = (opts?.harnesses ?? []).map((x) => ({
		value: x.id,
		label: x.label,
		icon: <HarnessGlyph harness={x.id} size={14} />,
		// Marked only once that machine's login shell answered.
		...(x.mode
			? { sub: x.mode === "acp" ? "Managed ACP" : "Native terminal" }
			: x.installed || opts?.checked === false
				? {}
				: { sub: `Not found on ${machine}` }),
	}));

	const branchOptions: PickerOption[] = (refs?.branches ?? []).map((b) => ({
		value: b.name,
		label: b.name,
		...(b.remote ? { badge: "remote" } : {}),
		icon: <GitBranchIcon />,
	}));

	const projectName = cwd
		? (projectOptions.find((o) => o.value === cwd)?.label ?? baseName(cwd))
		: null;

	/** Why Send can't go now, or null. */
	const why: string | null = optsError
		? optsError
		: !opts
			? `Loading ${machine}…`
			: !cwd
				? "Choose a project to start"
				: !harness
					? "Choose a harness"
					: workspace === "worktree" && refsLoading
						? "Preparing worktree"
						: workspace === "worktree" && refsError
							? refsError
							: workspace === "worktree" && refs && !refs.root
								? "That folder isn't a git repo. Use Current checkout."
								: workspace === "worktree" && !base
									? "Choose a base branch before creating a worktree."
									: null;
	const busy = phase === "starting" || (!!launch && launch.step !== "failed");

	async function submit(text: string) {
		if (why || busy || !cwd || !harness) return;
		pending.current = text;
		setError(null);
		setPhase("starting");
		const p: LaunchParams = {
			nonce: nonce.current,
			cwd,
			harness,
			workspace,
			...(workspace === "worktree" && base ? { base } : {}),
			...(text.trim() ? { prompt: text } : {}),
		};
		try {
			const s = await startLaunch(machine, p);
			setLaunchId(s.id);
		} catch (e) {
			setPhase("idle");
			if (!(e instanceof ProveCancelled)) setError(launchError(e, machine));
			restore();
		}
	}

	const hero = (
		<h1 className="ld-headline">
			<span className="ld-word">Start an agent in</span>{" "}
			<Picker
				label="Project"
				variant="hero"
				mobile={mobile}
				value={cwd}
				display={projectName ?? "Choose a project"}
				options={projectOptions}
				search="Search projects..."
				empty="No matching projects."
				loading={opts || optsError ? null : "Loading projects…"}
				onChange={setCwd}
				testId="launch-project"
				extra={(q, close, setQuery) =>
					looksLikePath(q) ? (
						<button
							type="button"
							className="lp-extra"
							onClick={() => {
								setExtraPaths((x) => [q, ...x]);
								setCwd(q);
								close();
							}}
						>
							Use {q}
						</button>
					) : (
						<button
							type="button"
							className="lp-extra"
							onClick={() => setQuery("~/")}
						>
							Add path…
						</button>
					)
				}
			/>{" "}
			<span className="ld-word">on</span>{" "}
			<Picker
				label="Machine"
				variant="hero"
				mobile={mobile}
				value={machine}
				options={machineOptions}
				search="Search machines..."
				empty="No matching machines."
				onChange={(m) => {
					if (m === machine) return;
					setMachine(m);
					setCwd(null);
					setExtraPaths([]);
					setRefs(null);
					setBase(null);
				}}
				testId="launch-machine"
			/>
		</h1>
	);

	const controls = (
		<>
			<Picker
				label="Harness"
				mobile={mobile}
				value={harness}
				options={harnessOptions}
				search="Search harnesses..."
				loading={opts ? null : "Loading…"}
				icon={
					harness ? <HarnessGlyph harness={harness} size={14} /> : undefined
				}
				display={harness ? HARNESS_LABEL[harness] : "Harness"}
				onChange={(v) => setHarness(v as LaunchHarness)}
				testId="launch-harness"
			/>
			<Picker
				label="Workspace"
				mobile={mobile}
				value={workspace}
				icon={workspace === "worktree" ? <FolderGitIcon /> : <FolderIcon />}
				options={[
					{ value: "current", label: "Current checkout", icon: <FolderIcon /> },
					{ value: "worktree", label: "New worktree", icon: <FolderGitIcon /> },
				]}
				onChange={(v) => setWorkspace(v as "current" | "worktree")}
				testId="launch-workspace"
			/>
			{workspace === "worktree" && (
				<Picker
					label="Base branch"
					mobile={mobile}
					value={base}
					icon={<GitBranchIcon />}
					display={base ?? "Base branch"}
					options={branchOptions}
					search="Search branches..."
					empty={
						refs && !refs.root ? "Not a git repo." : "No branches available"
					}
					loading={refsLoading ? "Loading branches…" : null}
					onChange={setBase}
					testId="launch-base"
				/>
			)}
		</>
	);

	const sendButton = busy ? (
		<span className="ld-progress" role="status">
			<Loader2Icon className="animate-spin" aria-hidden="true" />
			<span className="ld-progress-text">
				{launch ? stepText(launch) : "Starting…"}
			</span>
			{launch && <span className="ld-timer">{elapsed}s</span>}
		</span>
	) : (
		<span className="ld-send-wrap" title={why ?? undefined}>
			<PromptInputSubmit
				className={`send-btn${mobile ? " m-send" : ""}`}
				status="ready"
				aria-label="Start agent"
				disabled={!!why}
			>
				{mobile ? (
					<ArrowUpIcon className="size-[18px]" strokeWidth={2.6} />
				) : undefined}
			</PromptInputSubmit>
		</span>
	);

	const timeline = launch && launch.step !== "failed" && (
		<div className="ld-timeline" aria-live="polite">
			{launch.step === "terminal" ? (
				<div className="ld-terminal">
					<AgentStatus
						state="needs-you"
						needsReason="terminal"
						variant="soft"
					/>
					<p>
						{launch.detail?.replace(/^Waiting in the terminal:\s*/i, "") ??
							"A dialog"}{" "}
						is open in the new terminal on {launch.machine}. Answer it there;
						your message goes out after that.
					</p>
					{launch.session && (
						<p className="ld-attach">
							<TerminalIcon aria-hidden="true" />
							<code>tmux attach -t {launch.session}</code>
						</p>
					)}
				</div>
			) : (
				<p className="ld-shimmer">{stepText(launch)}</p>
			)}
		</div>
	);

	return (
		<div
			className={`ld${mobile ? " ld-phone" : ""}`}
			data-testid="launch-draft"
		>
			<div className="ld-body">
				<div className="ld-hero">{hero}</div>
				{mobile && <div className="ld-chips">{controls}</div>}
				{timeline}
				{error && (
					<p className="ld-error" role="alert">
						{error}{" "}
						<button
							type="button"
							className="link"
							onClick={() => setError(null)}
						>
							<RotateCcwIcon aria-hidden="true" /> Try again
						</button>
					</p>
				)}
			</div>
			<div className={`composer ld-composer${mobile ? " m-composer" : ""}`}>
				<PromptInput
					onSubmit={(msg) => void submit(msg.text)}
					className={mobile ? "prompt m-prompt" : "prompt"}
				>
					<PromptInputBody>
						<PromptInputTextarea
							ref={ta}
							className="composer-input"
							placeholder="Ask anything"
							aria-label="First message"
							disabled={busy}
							onChange={(e) => setHasText(!!e.currentTarget.value.trim())}
						/>
					</PromptInputBody>
					{mobile ? (
						sendButton
					) : (
						<PromptInputFooter className="composer-bar">
							<PromptInputTools className="composer-tools">
								{controls}
							</PromptInputTools>
							{!busy && (
								<span className="composer-hint hide-mobile">
									<Kbd keys={["mod", "enter"]} />{" "}
									{hasText ? "Start" : "Start without a message"}
								</span>
							)}
							{sendButton}
						</PromptInputFooter>
					)}
				</PromptInput>
				{why && !busy && !error && (
					<p className="ld-why" data-testid="launch-why">
						{why}
					</p>
				)}
			</div>
		</div>
	);
}

export const Draft = observer(DraftImpl);
