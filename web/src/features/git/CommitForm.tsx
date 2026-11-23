/**
 * The commit form (desktop dialog and phone sheet): the branch, the files
 * with Edit to leave some out, a required message ("Draft from changes"
 * fills one from the files, no AI), and Commit / Commit on new branch. On
 * the default branch, Commit asks first.
 */
import { GitBranchIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRow, ChangedFile, GitStatus } from "../../api/types.ts";
import { useChanges } from "../../changes/data.ts";
import { branchFrom, draftMessage } from "./model.ts";
import type { CommitChoice } from "./run.ts";

const LETTER: Record<ChangedFile["status"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	conflicted: "U",
	untracked: "U",
};

function FileCells({ f, on }: { f: ChangedFile; on: boolean }) {
	const slash = f.path.lastIndexOf("/");
	return (
		<>
			<span className={`g-letter ${f.status}`} title={f.status}>
				{LETTER[f.status]}
			</span>
			<span className="g-path" title={f.path}>
				{slash >= 0 && (
					<span className="g-dir">{f.path.slice(0, slash + 1)}</span>
				)}
				{f.path.slice(slash + 1)}
			</span>
			{on ? (
				<span className="g-stat">
					{f.added != null && <span className="g-add">+{f.added}</span>}
					{f.removed != null && <span className="g-del">−{f.removed}</span>}
				</span>
			) : (
				<span className="g-excluded">Excluded</span>
			)}
		</>
	);
}

function SelectAll({
	all,
	some,
	onChange,
}: {
	all: boolean;
	some: boolean;
	onChange: (on: boolean) => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = some && !all;
	}, [all, some]);
	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label="Select all files"
			checked={all}
			onChange={(e) => onChange(e.target.checked)}
		/>
	);
}

export function CommitForm({
	agent,
	status,
	mobile,
	onCommit,
	onCancel,
}: {
	agent: AgentRow;
	status: GitStatus;
	mobile: boolean;
	onCommit: (c: CommitChoice) => void;
	onCancel: () => void;
}) {
	const changes = useChanges(agent.id, "worktree").data;
	const files = changes?.available ? changes.files : [];
	const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
	const [editing, setEditing] = useState(false);
	const [message, setMessage] = useState("");
	const detached = !status.branch;
	const [branchMode, setBranchMode] = useState(detached);
	const [branch, setBranch] = useState("");
	const [askDefault, setAskDefault] = useState(false);
	const branchInput = useRef<HTMLInputElement>(null);
	const chosen = useMemo(
		() => files.filter((f) => !excluded.has(f.path)),
		[files, excluded],
	);
	const added = chosen.reduce((n, f) => n + (f.added ?? 0), 0);
	const removed = chosen.reduce((n, f) => n + (f.removed ?? 0), 0);
	const missing =
		chosen.length === 0
			? "Pick at least one file."
			: !message.trim()
				? "Write a commit message."
				: null;
	const choice = (over: Partial<CommitChoice> = {}): CommitChoice => ({
		files: chosen.map((f) => f.path),
		message: message.trim(),
		...over,
	});
	const commitHere = () => {
		if (missing) return;
		if (status.onDefault) return setAskDefault(true);
		onCommit(choice());
	};
	const commitNew = () => {
		if (missing) return;
		if (!branchMode) {
			setBranchMode(true);
			setBranch(branchFrom(message, agent.name));
			setTimeout(() => branchInput.current?.select(), 0);
			return;
		}
		if (!branch.trim()) return;
		onCommit(choice({ newBranch: branch.trim() }));
	};
	const btn = (kind: "primary" | "plain" | "ghost") =>
		mobile
			? kind === "primary"
				? "m-btn"
				: kind === "plain"
					? "m-btn tinted"
					: "m-btn gray"
			: kind === "primary"
				? "d-btn primary"
				: kind === "plain"
					? "d-btn"
					: "d-btn ghost";
	const toggle = (path: string, on: boolean) =>
		setExcluded((s) => {
			const n = new Set(s);
			if (on) n.delete(path);
			else n.add(path);
			return n;
		});

	if (askDefault)
		return (
			<div className={`g-commit${mobile ? " mobile" : ""}`}>
				<div className="g-confirm" role="alert">
					<TriangleAlertIcon aria-hidden="true" />
					<div>
						<strong>Run on the default branch?</strong>
						<p>
							This commits straight to {status.branch}. A new branch keeps it
							apart until a PR.
						</p>
					</div>
				</div>
				<div className={mobile ? "g-sheet-foot" : "d-pop-foot"}>
					<button
						type="button"
						className={btn("ghost")}
						onClick={() => setAskDefault(false)}
					>
						Back
					</button>
					<button
						type="button"
						className={btn("plain")}
						onClick={() => {
							setAskDefault(false);
							commitNew();
						}}
					>
						Commit on new branch
					</button>
					<button
						type="button"
						className={btn("primary")}
						onClick={() => onCommit(choice({ confirmDefault: true }))}
					>
						Commit to {status.branch}
					</button>
				</div>
			</div>
		);

	return (
		<div className={`g-commit${mobile ? " mobile" : ""}`}>
			<div className="g-branch-row">
				<GitBranchIcon aria-hidden="true" />
				{detached ? (
					<span className="g-branch">Detached HEAD</span>
				) : (
					<span className="g-branch" title={status.branch ?? undefined}>
						{status.branch}
					</span>
				)}
				{status.onDefault && (
					<span className="g-chip warn">Default branch</span>
				)}
				{detached && (
					<span className="g-chip warn">Commit on a new branch</span>
				)}
			</div>
			{branchMode && (
				<label className="g-field">
					<span>New branch</span>
					<input
						ref={branchInput}
						className={mobile ? "g-input" : "d-input g-input"}
						value={branch}
						placeholder="pulsar/my-change"
						onChange={(e) => setBranch(e.target.value)}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
				</label>
			)}
			<div className="g-files-head">
				{editing && (
					<SelectAll
						all={excluded.size === 0}
						some={chosen.length > 0}
						onChange={(on) =>
							setExcluded(on ? new Set() : new Set(files.map((f) => f.path)))
						}
					/>
				)}
				<span className="g-files-title">
					{chosen.length === files.length
						? `${files.length} ${files.length === 1 ? "file" : "files"}`
						: `${chosen.length} of ${files.length} files`}
				</span>
				<span className="g-stat">
					<span className="g-add">+{added}</span>
					<span className="g-del">−{removed}</span>
				</span>
				<button
					type="button"
					className={mobile ? "g-link" : "d-btn ghost sm"}
					aria-pressed={editing}
					onClick={() => setEditing((e) => !e)}
				>
					{editing ? "Done" : "Edit"}
				</button>
			</div>
			<ul className="g-files" aria-label="Files">
				{!changes && <li className="g-file muted">Loading files…</li>}
				{files.map((f) => {
					const on = !excluded.has(f.path);
					return (
						<li key={f.path} className={`g-file${on ? "" : " excluded"}`}>
							{editing ? (
								<label className="g-file-row">
									<input
										type="checkbox"
										checked={on}
										aria-label={f.path}
										onChange={(e) => toggle(f.path, e.target.checked)}
									/>
									<FileCells f={f} on={on} />
								</label>
							) : (
								<div className="g-file-row">
									<FileCells f={f} on={on} />
								</div>
							)}
						</li>
					);
				})}
			</ul>
			<div className="g-msg-head">
				<label htmlFor={`g-msg-${mobile ? "m" : "d"}`}>Commit message</label>
				<button
					type="button"
					className={mobile ? "g-link" : "d-btn ghost sm"}
					disabled={chosen.length === 0}
					onClick={() => setMessage(draftMessage(chosen))}
				>
					<SparklesIcon aria-hidden="true" />
					Draft from changes
				</button>
			</div>
			<textarea
				id={`g-msg-${mobile ? "m" : "d"}`}
				className={mobile ? "g-textarea" : "d-input g-textarea"}
				placeholder="Describe your changes…"
				value={message}
				rows={mobile ? 4 : 5}
				onChange={(e) => setMessage(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						if (branchMode) commitNew();
						else commitHere();
					}
				}}
			/>
			<div className={mobile ? "g-sheet-foot" : "d-pop-foot"}>
				<button type="button" className={btn("ghost")} onClick={onCancel}>
					Cancel
				</button>
				<button
					type="button"
					className={btn(branchMode ? "primary" : "plain")}
					disabled={!!missing || (branchMode && !branch.trim())}
					title={missing ?? undefined}
					onClick={commitNew}
				>
					Commit on new branch
				</button>
				{!branchMode && (
					<button
						type="button"
						className={btn("primary")}
						disabled={!!missing}
						title={missing ?? undefined}
						onClick={commitHere}
					>
						Commit
					</button>
				)}
			</div>
		</div>
	);
}
