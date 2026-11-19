/**
 * Single-dollar inline math (`$x$`) without eating prices.
 *
 * remark-math's `singleDollarTextMath` pairs any two `$`, so "$5 and $6"
 * becomes math "5 and ". This remark plugin runs after it and turns such
 * spans back into text, by Pandoc's rule: the content may not start or end
 * with whitespace, and the closing `$` may not be followed by a digit.
 * `$$…$$` is left alone.
 */
interface Node {
	type: string;
	value?: string;
	children?: Node[];
	position?: { start: { offset?: number }; end: { offset?: number } };
}

export function dollarGuard() {
	return (tree: Node, file: { toString(): string }) => {
		const src = String(file);
		const walk = (parent: Node) => {
			const kids = parent.children;
			if (!kids) return;
			for (let i = 0; i < kids.length; i++) {
				const n = kids[i]!;
				if (n.type === "inlineMath") {
					const start = n.position?.start.offset;
					const end = n.position?.end.offset;
					if (start === undefined || end === undefined) continue;
					const raw = src.slice(start, end);
					if (raw.startsWith("$$")) continue;
					const v = n.value ?? "";
					if (!v.trim() || /^\s|\s$/.test(v) || /^\d/.test(src.slice(end)))
						kids[i] = { type: "text", value: raw };
				} else walk(n);
			}
		};
		walk(tree);
	};
}
