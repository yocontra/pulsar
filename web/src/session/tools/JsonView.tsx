/**
 * Lazy: a JSON value as a collapsible tree. Objects and arrays below the
 * first level start folded; long arrays show their first items. Every value
 * is a text node.
 */
import { useState } from "react";

const MAX_ITEMS = 50;

function Scalar({ value }: { value: unknown }) {
	if (value === null) return <span className="ds-json-null">null</span>;
	if (typeof value === "string")
		return <span className="ds-json-str">"{value}"</span>;
	if (typeof value === "number")
		return <span className="ds-json-num">{String(value)}</span>;
	if (typeof value === "boolean")
		return <span className="ds-json-bool">{String(value)}</span>;
	return <span>{String(value)}</span>;
}

function Node({
	name,
	value,
	depth,
}: {
	name?: string;
	value: unknown;
	depth: number;
}) {
	// Before any early return: a hook must run on every render of a node.
	const [all, setAll] = useState(false);
	const label =
		name !== undefined ? <span className="ds-json-key">{name}: </span> : null;
	if (value === null || typeof value !== "object")
		return (
			<div className="ds-json-row">
				{label}
				<Scalar value={value} />
			</div>
		);
	const isArray = Array.isArray(value);
	const entries: [string, unknown][] = isArray
		? (value as unknown[]).map((v, i) => [String(i), v])
		: Object.entries(value as Record<string, unknown>);
	const shown = all ? entries : entries.slice(0, MAX_ITEMS);
	const count = isArray
		? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
		: `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;
	if (entries.length === 0)
		return (
			<div className="ds-json-row">
				{label}
				<span className="ds-json-punct">{isArray ? "[]" : "{}"}</span>
			</div>
		);
	return (
		<details className="ds-json-node" open={depth < 1}>
			<summary className="ds-json-row">
				{label}
				<span className="ds-json-punct">{isArray ? "[" : "{"}</span>
				<span className="ds-json-count">{count}</span>
			</summary>
			<div className="ds-json-children">
				{shown.map(([k, v]) => (
					<Node
						key={k}
						name={isArray ? undefined : k}
						value={v}
						depth={depth + 1}
					/>
				))}
				{entries.length > shown.length && (
					<button
						type="button"
						className="ds-json-more"
						onClick={() => setAll(true)}
					>
						Show {entries.length - shown.length} more
					</button>
				)}
			</div>
		</details>
	);
}

export default function JsonView({ value }: { value: unknown }) {
	return (
		<div className="ds-json mono">
			<Node value={value} depth={0} />
		</div>
	);
}
