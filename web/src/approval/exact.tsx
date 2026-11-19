/**
 * Exact renderings, the safety view: every hidden character of a value as a
 * visible marker (see visible.ts). Shared by approval cards and the
 * conversation's design-system entry.
 */
import { Fragment } from "react";
import { visible } from "./visible.ts";

/** A value rendered exactly, with every hidden character as a marker. */
export function Exact({ value }: { value: unknown }) {
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	const pieces = visible(text);
	return (
		<code className="exact">
			{pieces.map((p, i) =>
				p.mark === "nl" ? (
					<Fragment key={i}>
						<span className="mk mk-nl">{p.text}</span>
						{"\n"}
					</Fragment>
				) : p.mark ? (
					<span key={i} className={`mk mk-${p.mark}`}>
						{p.text}
					</span>
				) : (
					p.text
				),
			)}
		</code>
	);
}

/** A label (name, tool, cwd, rule) with hidden characters shown as markers. */
export function Marked({ text }: { text: string }) {
	return (
		<>
			{visible(text).map((p, i) =>
				p.mark === "ctl" || p.mark === "nl" ? (
					<span key={i} className={`mk mk-${p.mark}`}>
						{p.text}
					</span>
				) : p.mark === "space" ? (
					" "
				) : p.mark === "tab" ? (
					"\t"
				) : (
					p.text
				),
			)}
		</>
	);
}
