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
	file: File;
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
}

export class ComposerDraft {
	readonly files = signal<DraftFile[]>([]);
	/** Paths picked from the `@` menu (chips while `@path` stays in the text). */
	readonly mentions = signal<string[]>([]);

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
		if (f?.preview && !f.saved) URL.revokeObjectURL(f.preview);
		this.files.value = this.files.value.filter((x) => x.key !== key);
	}

	/** Empties the draft once its files went out with a message. */
	clear() {
		for (const f of this.files.value)
			if (f.preview && !f.saved) URL.revokeObjectURL(f.preview);
		this.files.value = [];
		this.mentions.value = [];
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
		return this.files.value.flatMap((f) => (f.saved ? [f.saved] : []));
	}

	/** The message body: the text, then one `Attached:` line per file. */
	body(text: string): string {
		const lines = this.ready().map(attachedLine);
		const t = text.trim();
		if (!lines.length) return t;
		return t ? `${t}\n\n${lines.join("\n")}` : lines.join("\n");
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
