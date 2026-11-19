/**
 * The composer's attachments, `@` file menu and Stop (lib/registry.tsx
 * slots `composer.left`, `composer.top`, `composer.right`).
 *
 * Files upload as soon as they are added: one Prove Human check for the
 * batch (the manifest of names, sizes and hashes; on another machine its
 * home node checks the passkey itself), then each file's bytes. Send waits
 * until every file is saved; the message then names them (Attached: lines,
 * lib/composer-draft.ts).
 */
import {
	FileIcon,
	FileTextIcon,
	FolderIcon,
	ImageIcon,
	PaperclipIcon,
	RotateCwIcon,
	SquareIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	ApiError,
	api,
	ProveCancelled,
	uploadAttachment,
} from "../../api/client.ts";
import type {
	AgentRow,
	AttachmentFileSpec,
	AttachmentUpload,
	FileHit,
} from "../../api/types.ts";
import { askStop, useStopping } from "../../data/pending.ts";
import { attachedPreviews, humanSize } from "../../lib/attachments.ts";
import {
	type ComposerDraft,
	type DraftFile,
	showsStop,
} from "../../lib/composer-draft.ts";
import type { ComposerSlotProps } from "../../lib/registry.tsx";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import "./composer.css";

const MAX_FILES = 10;
const IMAGE_MAX = 10 * 1024 * 1024;
const FILE_MAX = 25 * 1024 * 1024;
/** A paste this long becomes a .txt attachment. */
const LARGE_PASTE = 32 * 1024;

/** Attachments go to one agent's machine: only a composer for one agent. */
const agentOf = (p: ComposerSlotProps): AgentRow | null =>
	p.target.kind === "agent" && can("attachments") ? p.target.agent : null;

// ------------------------------------------------------------- uploading

/** The open upload each draft file belongs to, for its bytes and a Retry. */
const uploads = new Map<
	string,
	{ agent: string; upload: string; index: number; expiresAt: number }
>();

const hex = (b: ArrayBuffer) =>
	[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256(file: Blob): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

function nonce(): string {
	const b = crypto.getRandomValues(new Uint8Array(18));
	return btoa(String.fromCharCode(...b))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

let seq = 0;
const newKey = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

const errorText = (e: unknown) =>
	e instanceof ApiError || e instanceof Error ? e.message : "Upload failed";

/** Adds files to the draft and uploads them (checks the limits first). */
export async function attachFiles(
	draft: ComposerDraft,
	agent: AgentRow,
	incoming: File[],
) {
	const room = MAX_FILES - draft.files.value.length;
	if (incoming.length > room)
		void toast(`You can attach up to ${MAX_FILES} files per message.`, {
			tone: "error",
		});
	const batch: DraftFile[] = [];
	for (const file of incoming.slice(0, Math.max(0, room))) {
		const image = file.type.startsWith("image/");
		const name = file.name || "file";
		if (file.size === 0) {
			void toast(`'${name}' is empty or could not be read.`, { tone: "error" });
			continue;
		}
		if (file.size > (image ? IMAGE_MAX : FILE_MAX)) {
			void toast(`'${name}' is too large to attach.`, {
				tone: "error",
				description: image ? "Images up to 10 MB." : "Files up to 25 MB.",
			});
			continue;
		}
		const f: DraftFile = {
			key: newKey(),
			file,
			name,
			size: file.size,
			image,
			preview: image ? URL.createObjectURL(file) : null,
			state: "preparing",
			progress: 0,
			error: null,
			saved: null,
		};
		draft.add(f);
		batch.push(f);
	}
	if (batch.length) await uploadBatch(draft, agent, batch);
}

async function uploadBatch(
	draft: ComposerDraft,
	agent: AgentRow,
	batch: DraftFile[],
) {
	const specs: AttachmentFileSpec[] = [];
	const ok: DraftFile[] = [];
	for (const f of batch) {
		try {
			specs.push({
				name: f.name,
				type: f.file.type,
				size: f.size,
				sha256: await sha256(f.file),
			});
			ok.push(f);
		} catch {
			draft.update(f.key, {
				state: "failed",
				error: `'${f.name}' is empty or could not be read.`,
			});
		}
	}
	if (!ok.length) return;
	const manifest = { nonce: nonce(), files: specs };
	let up: AttachmentUpload;
	try {
		up = await api.acting(
			"attachments.upload",
			{ agent: agent.id },
			manifest,
			(assertion) => api.attachments(agent.id, manifest, assertion),
		);
	} catch (e) {
		// Prove Human closed: the files were never sent anywhere.
		if (e instanceof ProveCancelled) {
			for (const f of ok) draft.remove(f.key);
			return;
		}
		for (const f of ok)
			draft.update(f.key, { state: "failed", error: errorText(e) });
		return;
	}
	ok.forEach((f, index) =>
		uploads.set(f.key, {
			agent: agent.id,
			upload: up.upload,
			index,
			expiresAt: up.expiresAt,
		}),
	);
	for (const f of ok) await putFile(draft, f.key);
}

async function putFile(draft: ComposerDraft, key: string) {
	const u = uploads.get(key);
	const f = draft.files.value.find((x) => x.key === key);
	if (!u || !f) return;
	const abort = new AbortController();
	draft.update(key, { state: "uploading", progress: 0, error: null, abort });
	// Removed (or the draft cleared) while it uploaded: nothing more to show.
	const gone = () =>
		abort.signal.aborted || !draft.files.value.some((x) => x.key === key);
	try {
		const r = await uploadAttachment(
			u.agent,
			u.upload,
			u.index,
			f.file,
			(p) => !gone() && draft.update(key, { progress: p }),
			abort.signal,
		);
		uploads.delete(key);
		if (gone()) return;
		if (f.preview) attachedPreviews.set(r.file.path, f.preview);
		draft.update(key, {
			state: "done",
			progress: 1,
			saved: r.file,
			abort: null,
		});
	} catch (e) {
		if (gone()) {
			uploads.delete(key);
			return;
		}
		// The upload is gone (expired, or the daemon restarted): Retry opens a new one.
		if (e instanceof ApiError && (e.code === "gone" || e.code === "not_found"))
			uploads.delete(key);
		draft.update(key, { state: "failed", error: errorText(e), abort: null });
	}
}

/** Retry: the same upload while it is open, else a new one (a new check). */
async function retry(draft: ComposerDraft, agent: AgentRow, key: string) {
	const u = uploads.get(key);
	if (u && u.expiresAt > Date.now() + 10_000) return putFile(draft, key);
	uploads.delete(key);
	const f = draft.files.value.find((x) => x.key === key);
	if (!f) return;
	draft.update(key, { state: "preparing", error: null, progress: 0 });
	await uploadBatch(draft, agent, [f]);
}

// ------------------------------------------------------------ attach button

function AttachButtonImpl(p: ComposerSlotProps) {
	const agent = agentOf(p);
	const files = useRef<HTMLInputElement>(null);
	const photos = useRef<HTMLInputElement>(null);
	const [menu, setMenu] = useState(false);
	if (!agent) return null;
	const pick = (input: HTMLInputElement) => {
		const list = input.files ? [...input.files] : [];
		input.value = "";
		if (list.length) void attachFiles(p.draft, agent, list);
	};
	const inputs = (
		<>
			<input
				ref={files}
				type="file"
				multiple
				hidden
				tabIndex={-1}
				data-testid="attach-files"
				onChange={(e) => pick(e.currentTarget)}
			/>
			<input
				ref={photos}
				type="file"
				accept="image/*"
				multiple
				hidden
				tabIndex={-1}
				data-testid="attach-photos"
				onChange={(e) => pick(e.currentTarget)}
			/>
		</>
	);
	if (!p.compact)
		return (
			<>
				<button
					type="button"
					className="att-btn"
					title="Attach files"
					aria-label="Attach files"
					onClick={() => files.current?.click()}
				>
					<PaperclipIcon aria-hidden="true" />
				</button>
				{inputs}
			</>
		);
	// Phone: Photo Library or Choose Files, as a pull-down menu.
	const choose = (input: HTMLInputElement | null) => {
		setMenu(false);
		input?.click();
	};
	return (
		<div className="m-prio m-attach">
			<button
				type="button"
				className="m-prio-btn"
				aria-label="Attach files"
				aria-haspopup="menu"
				aria-expanded={menu}
				onClick={() => setMenu(!menu)}
			>
				<PaperclipIcon className="size-[18px]" strokeWidth={2.2} />
			</button>
			{menu && (
				<>
					<div
						className="m-menu-shade"
						onClick={() => setMenu(false)}
						aria-hidden="true"
					/>
					<div className="m-menu" role="menu" aria-label="Attach">
						<button
							type="button"
							role="menuitem"
							className="m-menu-item"
							onClick={() => choose(photos.current)}
						>
							<span className="m-menu-check" />
							<span className="m-menu-text">Photo Library</span>
							<ImageIcon className="size-[18px]" />
						</button>
						<button
							type="button"
							role="menuitem"
							className="m-menu-item"
							onClick={() => choose(files.current)}
						>
							<span className="m-menu-check" />
							<span className="m-menu-text">Choose Files</span>
							<FileIcon className="size-[18px]" />
						</button>
					</div>
				</>
			)}
			{inputs}
		</div>
	);
}
export const AttachButton = observer(AttachButtonImpl);

// ------------------------------------------------- tiles, drop, paste, @

function ComposerTopImpl(p: ComposerSlotProps) {
	const agent = agentOf(p);
	const files = p.draft.files.value;
	const mentions = p.draft.mentions.value;
	const [dragging, setDragging] = useState(false);
	const [zoom, setZoom] = useState<DraftFile | null>(null);
	useDropAndPaste(p, agent, setDragging);
	const [menu, text] = useMentions(p, agent);
	if (!agent) return null;
	const shownMentions = mentions.filter((m) => text.includes(`@${m}`));
	return (
		<>
			{(files.length > 0 || shownMentions.length > 0) && (
				<div className="att-strip" data-align="block-start">
					{files.map((f) => (
						<Tile
							key={f.key}
							f={f}
							onRemove={() => {
								uploads.delete(f.key);
								p.draft.remove(f.key);
							}}
							onRetry={() => void retry(p.draft, agent, f.key)}
							onZoom={() => setZoom(f)}
						/>
					))}
					{shownMentions.map((m) => (
						<span key={m} className="mention-chip" title={m}>
							{m.endsWith("/") ? (
								<FolderIcon aria-hidden="true" />
							) : (
								<FileTextIcon aria-hidden="true" />
							)}
							<span className="mention-chip-name">{baseName(m)}</span>
							<button
								type="button"
								aria-label={`Remove @${m}`}
								onClick={() => removeMention(p, m)}
							>
								<XIcon aria-hidden="true" />
							</button>
						</span>
					))}
				</div>
			)}
			{dragging && (
				<div className="att-drop" aria-hidden="true">
					<span className="att-drop-pill">
						<PaperclipIcon />
						Drop files to attach
					</span>
				</div>
			)}
			{menu}
			{zoom?.preview && (
				<div
					className="att-zoom"
					role="dialog"
					aria-label={zoom.name}
					onClick={() => setZoom(null)}
					onKeyDown={(e) => e.key === "Escape" && setZoom(null)}
				>
					<img src={zoom.preview} alt={zoom.name} />
					<button
						type="button"
						className="att-zoom-x"
						aria-label="Close preview"
						// biome-ignore lint/a11y/noAutofocus: the preview is a dialog
						autoFocus
						onClick={() => setZoom(null)}
					>
						<XIcon />
					</button>
				</div>
			)}
		</>
	);
}
export const ComposerTop = observer(ComposerTopImpl);

function Tile({
	f,
	onRemove,
	onRetry,
	onZoom,
}: {
	f: DraftFile;
	onRemove: () => void;
	onRetry: () => void;
	onZoom: () => void;
}) {
	const busy = f.state === "preparing" || f.state === "uploading";
	const status =
		f.state === "preparing"
			? "Preparing"
			: f.state === "uploading"
				? `${Math.round(f.progress * 100)}%`
				: null;
	return (
		<div
			className={`att-tile${f.image ? "" : " is-file"}`}
			data-state={f.state}
			data-testid="attachment"
			title={f.error ?? f.name}
		>
			{f.image && f.preview ? (
				<button
					type="button"
					className="att-thumb"
					aria-label={`Preview ${f.name}`}
					onClick={onZoom}
				>
					<img src={f.preview} alt="" />
				</button>
			) : (
				<span className="att-file">
					<FileIcon aria-hidden="true" />
					<span className="att-file-name">{f.name}</span>
					<span className="att-file-size">{humanSize(f.size)}</span>
				</span>
			)}
			{busy && (
				<span className="att-status" role="status">
					{status}
				</span>
			)}
			{f.state === "failed" && (
				<button
					type="button"
					className="att-retry"
					title={f.error ?? "Upload failed"}
					aria-label={`Retry ${f.name}: ${f.error ?? "upload failed"}`}
					onClick={onRetry}
				>
					<RotateCwIcon aria-hidden="true" />
				</button>
			)}
			<button
				type="button"
				className="att-x"
				aria-label={`Remove ${f.name}`}
				onClick={onRemove}
			>
				<XIcon aria-hidden="true" />
			</button>
		</div>
	);
}

/** Files dropped on the composer, and images or long text pasted into it. */
function useDropAndPaste(
	p: ComposerSlotProps,
	agent: AgentRow | null,
	setDragging: (v: boolean) => void,
) {
	const latest = useRef({ draft: p.draft, agent });
	latest.current = { draft: p.draft, agent };
	useEffect(() => {
		const ta = p.textarea.current;
		const zone = ta?.closest<HTMLElement>(".composer");
		if (!ta || !zone || !agent) return;
		const add = (list: File[]) => {
			const { draft, agent } = latest.current;
			if (agent && list.length) void attachFiles(draft, agent, list);
		};
		let depth = 0;
		const hasFiles = (e: DragEvent) =>
			[...(e.dataTransfer?.types ?? [])].includes("Files");
		const enter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth++;
			setDragging(true);
		};
		const over = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		};
		const leave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (!depth) setDragging(false);
		};
		const drop = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth = 0;
			setDragging(false);
			add([...(e.dataTransfer?.files ?? [])]);
		};
		const paste = (e: ClipboardEvent) => {
			const data = e.clipboardData;
			if (!data) return;
			const text = data.getData("text/plain");
			// Text wins: Excel, Numbers and Word copy an image of the cells too.
			if (text) {
				if (text.length < LARGE_PASTE) return;
				e.preventDefault();
				const name = `Pasted text ${new Date().toTimeString().slice(0, 8).replace(/:/g, ".")}.txt`;
				add([new File([text], name, { type: "text/plain" })]);
				void toast(`Large paste attached as ${name}`);
				return;
			}
			const images = [...data.files].filter((f) => f.type.startsWith("image/"));
			if (!images.length) return;
			e.preventDefault();
			add(images);
		};
		zone.addEventListener("dragenter", enter);
		zone.addEventListener("dragover", over);
		zone.addEventListener("dragleave", leave);
		zone.addEventListener("drop", drop);
		ta.addEventListener("paste", paste);
		return () => {
			zone.removeEventListener("dragenter", enter);
			zone.removeEventListener("dragover", over);
			zone.removeEventListener("dragleave", leave);
			zone.removeEventListener("drop", drop);
			ta.removeEventListener("paste", paste);
		};
	}, [p.textarea, agent?.id, setDragging]);
}

// ---------------------------------------------------------------- @ menu

const baseName = (path: string) => {
	const p = path.replace(/\/$/, "");
	return p.slice(p.lastIndexOf("/") + 1) || p;
};
const dirName = (path: string) => {
	const p = path.replace(/\/$/, "");
	const i = p.lastIndexOf("/");
	return i > 0 ? p.slice(0, i) : "";
};

/** The `@word` the caret is in, or null. */
function tokenAt(ta: HTMLTextAreaElement): { start: number; q: string } | null {
	if (ta.selectionStart !== ta.selectionEnd) return null;
	const before = ta.value.slice(0, ta.selectionStart);
	const m = /(^|\s)@([^\s@]*)$/.exec(before);
	if (!m) return null;
	return { start: before.length - m[2]!.length - 1, q: m[2]! };
}

/** Replaces text in the field the way typing would (React sees an input event). */
function replaceText(
	ta: HTMLTextAreaElement,
	start: number,
	end: number,
	text: string,
) {
	ta.focus();
	ta.setRangeText(text, start, end, "end");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function removeMention(p: ComposerSlotProps, path: string) {
	const ta = p.textarea.current;
	if (ta) {
		const at = ta.value.indexOf(`@${path}`);
		if (at >= 0) {
			const end = at + path.length + 1;
			replaceText(ta, at, ta.value[end] === " " ? end + 1 : end, "");
		}
	}
	p.draft.mentions.value = p.draft.mentions.value.filter((m) => m !== path);
}

const MENU_ID = "composer-mentions";

/**
 * The `@` menu, docked above the composer: its element (or null), and the
 * field's text (for the chips of picked paths).
 */
function useMentions(
	p: ComposerSlotProps,
	agent: AgentRow | null,
): [ReactNode, string] {
	const [open, setOpen] = useState<{ start: number; q: string } | null>(null);
	const [text, setText] = useState("");
	const pickRef = useRef<((h: FileHit) => void) | null>(null);
	const [items, setItems] = useState<FileHit[]>([]);
	const [loading, setLoading] = useState(false);
	const [active, setActive] = useState(0);
	const [reason, setReason] = useState<string | null>(null);
	const [truncated, setTruncated] = useState(false);
	const state = useRef({ open, items, active });
	state.current = { open, items, active };
	const list = useRef<HTMLDivElement>(null);

	// Follow the caret: open on `@word`, close when it leaves.
	useEffect(() => {
		const ta = p.textarea.current;
		if (!ta || !agent) return;
		// The `@` the operator closed with Escape stays closed while the caret is in it.
		let dismissed: number | null = null;
		const check = () => {
			setText(ta.value);
			const t = tokenAt(ta);
			if (t?.start !== dismissed) dismissed = null;
			setOpen((o) =>
				t && dismissed === null
					? o && o.start === t.start && o.q === t.q
						? o
						: t
					: null,
			);
		};
		const pick = (h: FileHit) => {
			const o = state.current.open;
			if (!o) return;
			const path = h.kind === "dir" ? `${h.path}/` : h.path;
			// A folder keeps the menu open on what it holds.
			replaceText(
				ta,
				o.start,
				ta.selectionStart,
				`@${path}${h.kind === "dir" ? "" : " "}`,
			);
			if (!p.draft.mentions.value.includes(path))
				p.draft.mentions.value = [...p.draft.mentions.value, path];
			if (h.kind !== "dir") setOpen(null);
		};
		const key = (e: KeyboardEvent) => {
			const { open, items, active } = state.current;
			if (open && !e.isComposing) {
				const n = items.length;
				const stop = () => {
					e.preventDefault();
					e.stopPropagation();
				};
				if (e.key === "ArrowDown" && n) {
					stop();
					setActive((active + 1) % n);
					return;
				}
				if (e.key === "ArrowUp" && n) {
					stop();
					setActive((active - 1 + n) % n);
					return;
				}
				if (
					(e.key === "Enter" || e.key === "Tab") &&
					n &&
					!e.metaKey &&
					!e.ctrlKey
				) {
					stop();
					pick(items[active]!);
					return;
				}
				if (e.key === "Escape") {
					stop();
					dismissed = open.start;
					setOpen(null);
					return;
				}
			}
			// A picked `@path` deletes like one character.
			if (e.key === "Backspace" && ta.selectionStart === ta.selectionEnd) {
				const before = ta.value.slice(0, ta.selectionStart);
				for (const m of p.draft.mentions.value) {
					const token = `@${m}`;
					const tail = before.endsWith(`${token} `)
						? `${token} `
						: before.endsWith(token)
							? token
							: null;
					if (!tail) continue;
					const at = before.length - tail.length;
					if (at > 0 && !/\s/.test(before[at - 1]!)) continue;
					e.preventDefault();
					replaceText(ta, at, ta.selectionStart, "");
					return;
				}
			}
		};
		const close = () => setOpen(null);
		pickRef.current = pick;
		ta.addEventListener("input", check);
		ta.addEventListener("click", check);
		ta.addEventListener("keyup", check);
		ta.addEventListener("blur", close);
		ta.addEventListener("keydown", key, true);
		return () => {
			pickRef.current = null;
			ta.removeEventListener("input", check);
			ta.removeEventListener("click", check);
			ta.removeEventListener("keyup", check);
			ta.removeEventListener("blur", close);
			ta.removeEventListener("keydown", key, true);
		};
	}, [p.textarea, agent?.id, p.draft]);

	// Search as the query changes (debounced, the last one wins).
	const q = open?.q ?? null;
	useEffect(() => {
		if (q === null || !agent) return;
		const ac = new AbortController();
		setLoading(true);
		const t = setTimeout(() => {
			api.files(agent.id, q, ac.signal).then(
				(r) => {
					setItems(r.items);
					setReason(r.available ? null : (r.reason ?? null));
					setTruncated(r.truncated === true);
					setActive(0);
					setLoading(false);
				},
				(e: unknown) => {
					if ((e as Error).name === "AbortError") return;
					setItems([]);
					setReason(errorText(e));
					setLoading(false);
				},
			);
		}, 120);
		return () => {
			clearTimeout(t);
			ac.abort();
		};
	}, [q, agent?.id]);

	// The field names the menu and its active row while it is open.
	useEffect(() => {
		const ta = p.textarea.current;
		if (!ta) return;
		if (open) {
			ta.setAttribute("aria-controls", MENU_ID);
			ta.setAttribute("aria-expanded", "true");
			if (items[active])
				ta.setAttribute("aria-activedescendant", `${MENU_ID}-${active}`);
			else ta.removeAttribute("aria-activedescendant");
		} else {
			ta.removeAttribute("aria-controls");
			ta.removeAttribute("aria-activedescendant");
			ta.removeAttribute("aria-expanded");
		}
		list.current
			?.querySelector<HTMLElement>(`#${MENU_ID}-${active}`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, active, items, p.textarea]);

	if (!open || !agent) return [null, text];
	const pick = (h: FileHit) => pickRef.current?.(h);
	const empty =
		reason === "not_git"
			? "No git repository in this agent's folder."
			: reason === "unavailable"
				? "Couldn't list the files in this agent's folder."
				: reason === "no_cwd"
					? "This agent has no folder."
					: reason === "unsupported"
						? "That machine runs an older Pulsar."
						: (reason ?? "No matching files or folders.");
	// Docked above the whole composer (the field's box clips what overflows it).
	const root = p.textarea.current?.closest<HTMLElement>(".composer");
	const el = (
		<div
			className="mention-menu"
			id={MENU_ID}
			role="listbox"
			aria-label="Files"
			ref={list}
		>
			{loading && !items.length ? (
				<p className="mention-empty" role="status">
					Searching files…
				</p>
			) : !items.length ? (
				<p className="mention-empty">{empty}</p>
			) : (
				<>
					{items.map((h, i) => (
						<div
							key={h.path}
							id={`${MENU_ID}-${i}`}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							className="mention-item"
							// Keep the field's focus and caret.
							onMouseDown={(e) => {
								e.preventDefault();
								pick(h);
							}}
							onMouseEnter={() => setActive(i)}
						>
							{h.kind === "dir" ? (
								<FolderIcon aria-hidden="true" />
							) : (
								<FileTextIcon aria-hidden="true" />
							)}
							<span className="mention-name">{baseName(h.path)}</span>
							<span className="mention-path">{dirName(h.path)}</span>
						</div>
					))}
					{truncated && (
						<p className="mention-empty">
							This folder is large: only its first 200,000 files are searched.
						</p>
					)}
				</>
			)}
		</div>
	);
	return [root ? createPortal(el, root) : el, text];
}

// ------------------------------------------------------------------ Stop

function ComposerStopImpl(p: ComposerSlotProps) {
	const agent = p.target.kind === "agent" ? p.target.agent : null;
	const stopping = useStopping(agent?.id ?? "");
	if (!agent || !showsStop(agent, p.hasText, p.draft)) return null;
	const label = stopping ? "Stopping…" : "Stop";
	return (
		<button
			type="button"
			className={p.compact ? "m-send att-stop" : "send-btn att-stop"}
			// Named apart from the header's Stop, which stays "Stop".
			aria-label={stopping ? "Stopping…" : "Stop turn"}
			title={label}
			disabled={stopping}
			onClick={() =>
				p.compact
					? void import("../../mobile/actions.ts").then((m) =>
							m.confirmStop(agent),
						)
					: askStop(agent.id)
			}
		>
			<SquareIcon aria-hidden="true" />
		</button>
	);
}
export const ComposerStop = observer(ComposerStopImpl);
