/**
 * The phone's changes pages: the changed files (`#/changes/<id>`), and one
 * file's unified diff (`#/changes/<id>?f=<path>`), pushed on the agent's
 * page. Live like the desktop panel.
 */
import type { ChangesMode } from "../api/types.ts";
import { navigate } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { findAgent } from "../lib/store.ts";
import { BackButton } from "../mobile/BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "../mobile/ionic.ts";
import { useChanges } from "./data.ts";
import { FileDiff } from "./FileDiff.tsx";
import { Counts, Dir, FileList, StatusMark } from "./FileList.tsx";
import { MODE_LABEL, splitPath, unavailableText } from "./model.ts";
import { changesMode, setChangesMode } from "./panel-state.ts";
import "./changes.css";

function ListPage({ id, mode }: { id: string; mode: ChangesMode }) {
	const q = useChanges(id, mode);
	const s = q.data?.agent === id && q.data.mode === mode ? q.data : undefined;
	return (
		<div className="cv-phone">
			<div className="cv-head">
				<div className="cv-modes" role="radiogroup" aria-label="Compare">
					{(["worktree", "base"] as const).map((m) => (
						<button
							key={m}
							type="button"
							role="radio"
							aria-checked={mode === m}
							className={`cv-mode${mode === m ? " on" : ""}`}
							onClick={() => setChangesMode(m)}
						>
							{MODE_LABEL[m]}
						</button>
					))}
				</div>
				{s?.repo && (
					<p className="cv-branch">
						<span className="cv-repo">{s.repo}</span>
						<span aria-hidden="true">/</span>
						<span className="cv-ref">
							{s.branch ??
								(s.head
									? `detached at ${s.head.slice(0, 7)}`
									: "no commits yet")}
						</span>
						{s.available && s.total > 0 && (
							<span className="cv-total">
								<span className="add">+{s.added}</span>
								<span className="del">−{s.removed}</span>
							</span>
						)}
					</p>
				)}
			</div>
			{!s && q.isError && (
				<p className="cv-empty" role="alert">
					Couldn't read this agent's changes.
				</p>
			)}
			{!s && !q.isError && (
				<div className="cv-loading" aria-busy="true">
					<span className="cv-sr">Loading changes</span>
				</div>
			)}
			{s && !s.available && (
				<p className="cv-empty" role="status">
					{unavailableText(s)}
				</p>
			)}
			{s?.available && s.total === 0 && (
				<p className="cv-empty" role="status">
					{mode === "base" && s.base
						? `No changes on ${s.branch ?? "this branch"} since ${s.base.ref}`
						: `No changes in ${s.branch ?? "this worktree"}`}
				</p>
			)}
			{s?.available && s.files.length > 0 && (
				<>
					<FileList
						files={s.files}
						label="Changed files"
						onSelect={(f) => navigate({ view: "changes", id, file: f.path })}
					/>
					{s.truncated && (
						<p className="cv-more">
							Showing {s.files.length} of {s.total} files.
						</p>
					)}
				</>
			)}
		</div>
	);
}

function FilePage({
	id,
	mode,
	path,
}: {
	id: string;
	mode: ChangesMode;
	path: string;
}) {
	const q = useChanges(id, mode);
	const s = q.data?.agent === id && q.data.mode === mode ? q.data : undefined;
	const file = s?.files.find((f) => f.path === path);
	if (!s && q.isError)
		return (
			<p className="cv-empty" role="alert">
				Couldn't read this agent's changes.
			</p>
		);
	if (!s)
		return (
			<div className="cv-loading" aria-busy="true">
				<span className="cv-sr">Loading diff</span>
			</div>
		);
	if (!file)
		return (
			<p className="cv-empty" role="status">
				This file has no changes any more.
			</p>
		);
	return (
		<div className="cv-phone cv-phone-file">
			<h2 className="cv-section-head">
				<StatusMark file={file} />
				<span className="cv-name">
					{file.oldPath ? (
						<span className="cv-dir">from {file.oldPath}</span>
					) : (
						<Dir dir={splitPath(path).dir} />
					)}
				</span>
				<Counts file={file} />
			</h2>
			<FileDiff agentId={id} mode={mode} file={file} layout="unified" />
		</div>
	);
}

function ChangesPageImpl({ id, file }: { id: string; file?: string }) {
	const mode = changesMode.value;
	const a = findAgent(id);
	const route = { view: "changes" as const, id, ...(file ? { file } : {}) };
	return (
		<>
			<IonHeader>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={route} />
					</IonButtons>
					<IonTitle>
						<span className="p-nav-title">
							<h1>{file ? splitPath(file).name : "Changes"}</h1>
							{!file && a && <span className="p-nav-sub">{a.name}</span>}
						</span>
					</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent className="p-plain">
				{file ? (
					<FilePage id={id} mode={mode} path={file} />
				) : (
					<ListPage id={id} mode={mode} />
				)}
			</IonContent>
		</>
	);
}

export default observer(ChangesPageImpl);
