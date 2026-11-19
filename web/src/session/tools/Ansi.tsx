/** Lazy: terminal output with ANSI colors as styled spans (see ansi.ts). */
import { useMemo } from "react";
import { ansiClass, parseAnsi } from "./ansi.ts";

export default function AnsiText({ text }: { text: string }) {
	const spans = useMemo(() => parseAnsi(text), [text]);
	return (
		<>
			{spans.map((s, i) => {
				const cls = ansiClass(s);
				return cls ? (
					<span key={i} className={cls}>
						{s.text}
					</span>
				) : (
					s.text
				);
			})}
		</>
	);
}
