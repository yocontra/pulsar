import { FileIcon } from "lucide-react";
import { type AttachedRef, attachedPreviews } from "../lib/attachments.ts";
import "./attached.css";

/**
 * The files a message names (`Attached:` lines): a thumbnail for an image
 * this tab attached, else a chip with the name, type and size. The path is
 * on the agent's machine; the title shows it.
 */
export function AttachedFiles({ files }: { files: AttachedRef[] }) {
	return (
		<ul className="ds-attached" aria-label="Attachments">
			{files.map((f) => {
				const preview = f.type.startsWith("image/")
					? attachedPreviews.get(f.path)
					: undefined;
				return (
					<li key={f.path} title={f.path}>
						{preview ? (
							<img className="ds-attached-img" src={preview} alt={f.name} />
						) : (
							<span className="ds-attached-chip">
								<FileIcon aria-hidden="true" />
								<span className="ds-attached-name">{f.name}</span>
								<span className="ds-attached-size">{f.size}</span>
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}
