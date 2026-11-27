/**
 * What one composer holds besides its text: attached files (uploaded to the
 * agent's machine as they are added) and the files picked from the `@`
 * menu. The composer owns one per target; the attach feature
 * (features/composer) fills it through the toolbar slots. Kept tiny: it is
 * in the first-load bundle.
 */
import type { AgentRow, AttachmentSaved } from "../api/types.ts";
import { attachedLine } from "./attachments.ts";
import { signal } from "./signals.ts";
import { can } from "./store.ts";

export interface DraftFile {
	key: string;
	file?: File;
	name: string;
	size: number;
	image: boolean;
	/** An object URL for an image's tile. */
	preview: string | null;
	state: "preparing" | "uploading" | "done" | "failed";
	/** 0..1 while uploading. */
	progress: number;
	error: string | null;
	saved: AttachmentSaved | null;
	/** Cancels its upload in flight (set while the bytes go). */
	abort?: AbortController | null;
}

type SavedDraft = {
	revision: string;
	text: string;
	files: AttachmentSaved[];
	mentions: string[];
	asText: boolean;
};

const prefix = "pulsar:draft:";
const selectorDrafts = new Map<string, SavedDraft>();
let nextRevision = 0;

function read(key: string): SavedDraft | null {
	if (key.startsWith("selector:")) return selectorDrafts.get(key) ?? null;
	try {
		const value = sessionStorage.getItem(prefix + key);
		const draft = value ? (JSON.parse(value) as SavedDraft) : null;
		return draft &&
			typeof draft.text === "string" &&
			Array.isArray(draft.files) &&
			Array.isArray(draft.mentions)
			? draft
			: null;
	} catch {
		return null;
	}
}

function write(key: string, draft: SavedDraft | null) {
	if (key.startsWith("selector:")) {
		if (draft) selectorDrafts.set(key, draft);
		else selectorDrafts.delete(key);
	} else if (draft) sessionStorage.setItem(prefix + key, JSON.stringify(draft));
	else sessionStorage.removeItem(prefix + key);
}

export class ComposerDraft {
	readonly files = signal<DraftFile[]>([]);
	/** Paths picked from the `@` menu (chips while `@path` stays in the text). */
	readonly mentions = signal<string[]>([]);
	/**
	 * A draft that starts with `/` goes as a plain message, not a command
	 * (the "Send as text" choice under the `/` menu).
	 */
	readonly asText = signal(false);

	text: string;
	private revision = "";
	private content = "";
	private detached = false;
	private kept = true;
	private readonly storageKey: string;

	constructor(storageKey: string, legacyKey: string | null) {
		this.storageKey = storageKey;
		const saved = read(storageKey);
		this.text = saved?.text ?? (legacyKey && takeKeptDraft(legacyKey)) ?? "";
		if (saved) this.restore(saved);
	}

	private restore(saved: SavedDraft) {
		this.text = saved.text;
		this.revision = saved.revision;
		this.files.value = saved.files.map((file, index) => ({
			key: `saved-${index}`,
			name: file.name,
			size: file.size,
			image: file.type.startsWith("image/"),
			preview: null,
			state: "done",
			progress: 1,
			error: null,
			saved: file,
		}));
		this.mentions.value = saved.mentions;
		this.asText.value = saved.asText;
		this.content = this.fingerprint(this.snapshot());
	}

	private snapshot() {
		return {
			text: this.text,
			files: this.ready(),
			mentions: this.mentions.peek(),
			asText: this.asText.peek(),
		};
	}

	private fingerprint(snapshot: ReturnType<ComposerDraft["snapshot"]>) {
		return JSON.stringify([
			snapshot,
			this.files
				.peek()
				.filter((f) => !f.saved)
				.map((f) => f.key),
		]);
	}

	checkpoint(): { revision: string; saved: boolean } {
		try {
			const snapshot = this.snapshot();
			if (this.detached && !snapshot.text.trim() && !this.files.peek().length) {
				return { revision: "", saved: true };
			}
			this.detached = false;
			const content = this.fingerprint(snapshot);
			if (this.content === content && this.kept)
				return { revision: this.revision, saved: true };
			if (this.content !== content) {
				this.content = content;
				this.revision = `${performance.timeOrigin}:${++nextRevision}`;
			}
			write(
				this.storageKey,
				snapshot.text || snapshot.files.length
					? { ...snapshot, revision: this.revision }
					: null,
			);
			this.kept = true;
			return { revision: this.revision, saved: true };
		} catch {
			this.kept = false;
			return { revision: this.revision, saved: false };
		}
	}

	/** Free the visible box while its submitted snapshot waits for a receipt. */
	detach() {
		this.detached = true;
		this.content = "";
		this.text = "";
	}

	restoreDetached() {
		if (!this.detached) return;
		const saved = read(this.storageKey);
		if (saved) this.restore(saved);
		this.detached = false;
	}

	/** Ignore a late receipt if this target has since gained a new draft. */
	accept(revision: string) {
		try {
			if (read(this.storageKey)?.revision === revision)
				write(this.storageKey, null);
		} catch {}
	}

	/** The revision also changes for a file still uploading or one removed. */
	watch(sync: () => void) {
		const off = [this.files, this.mentions, this.asText].map((signal) =>
			signal.subscribe(sync),
		);
		return () => {
			for (const unsubscribe of off) unsubscribe();
		};
	}

	add(f: DraftFile) {
		this.files.value = [...this.files.value, f];
	}

	update(key: string, patch: Partial<DraftFile>) {
		this.files.value = this.files.value.map((f) =>
			f.key === key ? { ...f, ...patch } : f,
		);
	}

	remove(key: string) {
		const f = this.files.value.find((x) => x.key === key);
		f?.abort?.abort();
		if (f?.preview && !f.saved) URL.revokeObjectURL(f.preview);
		this.files.value = this.files.value.filter((x) => x.key !== key);
	}

	/** Empties the draft once its files went out with a message. */
	clear() {
		for (const f of this.files.value) {
			f.abort?.abort();
			if (f.preview && !f.saved) URL.revokeObjectURL(f.preview);
		}
		this.files.value = [];
		this.mentions.value = [];
		this.asText.value = false;
	}

	/** Why Send waits, or null. */
	blocked(): string | null {
		const fs = this.files.value;
		if (fs.some((f) => f.state === "preparing" || f.state === "uploading"))
			return "Wait for the files to finish uploading";
		if (fs.some((f) => f.state === "failed"))
			return "Remove or retry the file that failed";
		return null;
	}

	ready(): AttachmentSaved[] {
		return this.files.peek().flatMap((f) => (f.saved ? [f.saved] : []));
	}

	/** The message body: the text, then one `Attached:` line per file. */
	body(text: string): string {
		const lines = this.ready().map(attachedLine);
		const t = text.trim();
		if (!lines.length) return t;
		return t ? `${t}\n\n${lines.join("\n")}` : lines.join("\n");
	}
}

/**
 * The open composers by target key: what a reload into a new app build
 * keeps (data/update.ts) and what makes it wait (files being attached).
 */
export const openComposers = new Map<
	string,
	{
		draft: ComposerDraft;
		field: () => HTMLTextAreaElement | null;
		/** The message: the field's text, or the text being confirmed or sent. */
		text: () => string;
		accept: (revision: string) => void;
		persistent: boolean;
	}
>();

/** Include the recipient and delivery mode so a comment cannot enter another chat. */
export function directDraftKey(ids: string[] | undefined, viaParent = false) {
	return JSON.stringify([ids, viaParent]);
}

export function addAgentDraftText(
	id: string,
	quote: string,
	viaParent = false,
): string | null {
	const key = directDraftKey([id], viaParent);
	const open = openComposers.get(key);
	const field = open?.field();
	const draft = open?.draft ?? new ComposerDraft(key, `agent:${id}`);
	const prior = field?.value ?? draft.text;
	const value = prior ? `${prior}\n\n${quote}` : quote;
	if (draft.body(value).length > 64 * 1024)
		return "This would exceed the message limit. Select fewer lines.";
	if (field) {
		field.setRangeText(value, 0, field.value.length, "end");
		field.dispatchEvent(new Event("input", { bubbles: true }));
	} else {
		draft.text = value;
		if (!draft.checkpoint().saved)
			return "Could not save the review in the chat draft.";
	}
	return null;
}

/** sessionStorage: composer text kept across a reload, by target key. */
export const KEPT_DRAFTS = "pulsar:kept-drafts";

/**
 * Keeps every open composer's text across a reload (sessionStorage). False
 * when storage fails: nothing was kept.
 */
export function keepDrafts(): boolean {
	try {
		const all = JSON.parse(sessionStorage.getItem(KEPT_DRAFTS) ?? "{}");
		for (const [key, c] of openComposers) {
			if (c.persistent) {
				if (!c.draft.checkpoint().saved) return false;
				continue;
			}
			const text = c.text();
			if (text.trim()) all[key] = text;
		}
		sessionStorage.setItem(KEPT_DRAFTS, JSON.stringify(all));
		return true;
	} catch {
		return false;
	}
}

declare global {
	interface Window {
		/** For the boot guard's reloads (public/boot.js). */
		__pulsarKeepDrafts?: () => boolean;
	}
}
if (typeof window !== "undefined") window.__pulsarKeepDrafts = keepDrafts;

/** The text kept for `key` across a reload (once), or null. */
export function takeKeptDraft(key: string): string | null {
	try {
		const all = JSON.parse(sessionStorage.getItem(KEPT_DRAFTS) ?? "{}");
		const text = all[key];
		if (typeof text !== "string") return null;
		delete all[key];
		sessionStorage.setItem(KEPT_DRAFTS, JSON.stringify(all));
		return text;
	} catch {
		return null;
	}
}

/** Send turns into Stop: the agent works and the draft is empty. */
export function showsStop(
	agent: AgentRow | null,
	hasText: boolean,
	draft: ComposerDraft,
): boolean {
	return (
		!!agent &&
		agent.state === "busy" &&
		agent.canStop &&
		can("stop") &&
		!hasText &&
		draft.files.value.length === 0
	);
}
