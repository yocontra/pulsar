/**
 * The changed files: one row each, name first with its folder dimmed,
 * a status letter and +/−. Desktop selects in place; the phone pushes the
 * file's page (both pass `onSelect`).
 */
import type { ChangedFile } from "../api/types.ts";
import { STATUS_LABEL, STATUS_LETTER, splitPath } from "./model.ts";

export function StatusMark({ file }: { file: ChangedFile }) {
	return (
		<span
			className={`cv-status s-${file.status}`}
			title={STATUS_LABEL[file.status]}
		>
			<span aria-hidden="true">{STATUS_LETTER[file.status]}</span>
			<span className="cv-sr">{STATUS_LABEL[file.status]}</span>
		</span>
	);
}

/** A folder, ellipsized from the left when long ("…/auth/session"). */
export function Dir({ dir }: { dir: string }) {
	if (!dir) return null;
	return (
		<span className="cv-dir">
			<bdi>{dir.replace(/\/$/, "")}</bdi>
		</span>
	);
}

export function Counts({ file }: { file: ChangedFile }) {
	if (file.binary) return <span className="cv-counts muted">binary</span>;
	if (file.added === null && file.removed === null) return null;
	return (
		<span className="cv-counts">
			<span className="cv-sr">
				{file.added ?? 0} added, {file.removed ?? 0} removed
			</span>
			{!!file.added && (
				<span className="add" aria-hidden="true">
					+{file.added}
				</span>
			)}
			{!!file.removed && (
				<span className="del" aria-hidden="true">
					−{file.removed}
				</span>
			)}
		</span>
	);
}

export function FileList({
	files,
	selected,
	onSelect,
	label,
}: {
	files: ChangedFile[];
	selected?: string | null;
	onSelect: (f: ChangedFile) => void;
	label: string;
}) {
	return (
		<ul className="cv-files" aria-label={label}>
			{files.map((f) => {
				const { dir, name } = splitPath(f.path);
				const current = f.path === selected;
				return (
					<li key={f.path}>
						<button
							type="button"
							className={`cv-file${current ? " current" : ""}`}
							aria-current={current ? "true" : undefined}
							data-path={f.path}
							title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
							onClick={() => onSelect(f)}
						>
							<StatusMark file={f} />
							<span className="cv-name">
								<span className="cv-base">{name}</span>
								<Dir dir={dir} />
							</span>
							<Counts file={f} />
						</button>
					</li>
				);
			})}
		</ul>
	);
}
