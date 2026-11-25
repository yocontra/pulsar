import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { harden } from "rehype-harden";
import {
	type DiagramPlugin,
	defaultComponents,
	defaultRehypePlugins,
	type MathPlugin,
	type StreamdownProps,
} from "streamdown";
import { API_HEADER } from "../api/types.ts";
import "streamdown/styles.css";
import { CodeBlock } from "./CodeBlock.tsx";
import { dollarGuard } from "./dollars.ts";
import { FileRef, filePath, isFileHref } from "./file-ref.tsx";

/**
 * Streamdown settings for transcript text. Agents write this text, so:
 * - raw HTML is parsed then sanitized (rehype-sanitize: no scripts, no event
 *   handlers, no `javascript:`), never executed;
 * - links only to http(s) and mailto (harden, then externalLinks);
 * - images only from this origin's API (fetched with the X-Pulsar header
 *   into a blob: URL), `data:` or `blob:`, so an agent can't plant tracking
 *   pixels or make the browser request arbitrary URLs.
 * Streamdown's own default harden step allows everything ("*"); this replaces it.
 *
 * Shiki, Mermaid and KaTeX load on first use, each in its own chunk.
 */
const origin =
	typeof location === "undefined" ? "http://localhost" : location.origin;

export const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
	defaultRehypePlugins.raw!,
	fileUrls,
	defaultRehypePlugins.sanitize!,
	fileLinks,
	[
		harden,
		{
			defaultOrigin: origin,
			// "*" means any http(s) URL here; mailto passes by protocol. (Prefixes
			// like "https://" never parse as URLs, so they matched nothing.)
			allowedLinkPrefixes: ["*"],
			allowedProtocols: ["https", "http", "mailto"],
			allowedImagePrefixes: [`${origin}/api/`, "blob:", "data:image/"],
			allowDataImages: true,
		},
	],
	externalLinks,
];

type HastEl = {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastEl[];
};

/** Calls `fn` on every `<a href>` in the tree. */
function eachLink(fn: (a: HastEl, href: string) => void) {
	const walk = (n: HastEl) => {
		const href = n.properties?.href;
		if (n.type === "element" && n.tagName === "a" && typeof href === "string")
			fn(n, href);
		for (const c of n.children ?? []) walk(c);
	};
	return (tree: HastEl) => walk(tree);
}

/** Before sanitize (which drops `file:`): a file: URL becomes its plain path. */
function fileUrls() {
	return eachLink((a, href) => {
		if (/^file:/i.test(href)) a.properties!.href = filePath(href);
	});
}

/**
 * After sanitize, before harden (which would resolve a path against the
 * app's origin): file paths become file references (session/file-ref.tsx),
 * and an in-page `#anchor` becomes text (the app routes by its hash).
 */
function fileLinks() {
	return eachLink((a, href) => {
		if (href.startsWith("#")) {
			a.tagName = "span";
			a.properties = {};
		} else if (isFileHref(href)) {
			a.tagName = "file-ref";
			a.properties = { path: filePath(href) };
		}
	});
}

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Whether a link may stay a link: http(s) or mailto, after resolving it. */
export function allowedLink(href: string): boolean {
	try {
		return LINK_PROTOCOLS.has(new URL(href, origin).protocol);
	} catch {
		return false;
	}
}

/**
 * Links that survived harden open in a new tab without opener or referrer.
 * Harden always lets some schemes through (irc:, xmpp:): those become
 * text, the way harden shows the links it blocks.
 */
function externalLinks() {
	return eachLink((a, href) => {
		if (!href) return;
		if (allowedLink(href)) {
			a.properties!.target = "_blank";
			a.properties!.rel = ["noopener", "noreferrer"];
		} else {
			a.tagName = "span";
			a.properties = { title: "Blocked URL", className: ["text-gray-500"] };
			a.children = [
				...(a.children ?? []),
				{ type: "text", value: " [blocked]" },
			];
		}
	});
}

// ---------------------------------------------------------------- lazy plugins

type Changed = () => void;
const listeners = new Set<Changed>();
const notify = () => {
	for (const l of listeners) l();
};
const subscribe = (fn: Changed) => {
	listeners.add(fn);
	return () => listeners.delete(fn);
};

/** Mermaid: the library (and its diagram chunks) loads when a diagram renders. */
const MERMAID_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
type MermaidCfg = Parameters<DiagramPlugin["getMermaid"]>[0];
let mermaidConfig: MermaidCfg = {};
const mermaid: DiagramPlugin = {
	name: "mermaid",
	type: "diagram",
	language: "mermaid",
	getMermaid(config) {
		if (config) mermaidConfig = config;
		return {
			initialize(cfg) {
				mermaidConfig = cfg;
			},
			async render(id, source) {
				const m = (await import("mermaid")).default;
				reserveCytoscapeSheet();
				m.initialize({
					startOnLoad: false,
					// "base" colored from the Pulsar tokens, so diagrams match the app.
					theme: "base",
					// Same font as the scratch element Mermaid measures labels in (see
					// app.css): its own <style> is blocked by CSP there.
					fontFamily: MERMAID_FONT,
					themeVariables: {
						fontFamily: MERMAID_FONT,
						fontSize: "14px",
						...mermaidPalette(),
					},
					suppressErrorRendering: true,
					...(mermaidConfig as object),
					securityLevel: "strict",
				});
				const held = holdStyles(id);
				try {
					const out = await m.render(id, source);
					return { svg: cspSafeSvg(out.svg, id, held.rules) };
				} finally {
					held.release();
				}
			},
		};
	},
};

/**
 * Mermaid's mindmap lays out with cytoscape, which adds a <style> to the
 * page unless an element with its stylesheet id exists (blocked by CSP,
 * and logged). Its one rule is in conversation.css; this marker tells
 * cytoscape the sheet is there.
 */
const CYTOSCAPE_SHEET = "__________cytoscape_stylesheet";
function reserveCytoscapeSheet() {
	if (document.getElementById(CYTOSCAPE_SHEET)) return;
	const marker = document.createElement("meta");
	marker.id = CYTOSCAPE_SHEET;
	document.head.append(marker);
}

/**
 * Mermaid builds a diagram in a scratch <svg id=…> in the page and puts its
 * theme CSS in a <style> there, which `style-src 'self'` refuses (and logs)
 * the moment it lands. The refused sheet never styled the scratch copy, so
 * while a render runs, a <style> bound for that diagram's <svg> stays out of
 * the page and its text goes to cspSafeSvg, which applies it through CSSOM.
 */
const held = new Map<string, string[]>();
let insertBefore: typeof Node.prototype.insertBefore | null = null;

function holdStyles(id: string): { rules: string[]; release(): void } {
	const rules: string[] = [];
	held.set(id, rules);
	if (!insertBefore) {
		const original = Node.prototype.insertBefore;
		insertBefore = original;
		Node.prototype.insertBefore = function <T extends Node>(
			this: Node,
			node: T,
			child: Node | null,
		): T {
			const into =
				node instanceof HTMLStyleElement && this instanceof SVGSVGElement
					? held.get(this.id)
					: undefined;
			if (!into) return original.call(this, node, child) as T;
			into.push(node.textContent ?? "");
			return node;
		};
	}
	return {
		rules,
		release() {
			if (held.get(id) === rules) held.delete(id);
			if (held.size === 0 && insertBefore) {
				Node.prototype.insertBefore = insertBefore;
				insertBefore = null;
			}
		},
	};
}

/** Mermaid colors read from the live tokens (hex/rgb only; Mermaid can't read var()). */
function mermaidPalette(): Record<string, string | boolean> {
	const cs = getComputedStyle(document.documentElement);
	const t = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
	const dark =
		document.documentElement.dataset.theme === "dark" ||
		(document.documentElement.dataset.theme !== "light" &&
			matchMedia("(prefers-color-scheme: dark)").matches);
	const surface = t("--ds-surface-2", dark ? "#201f1e" : "#f6f5f3");
	const text = t("--ds-text", dark ? "#f2f1ef" : "#1c1917");
	const line = dark ? "#66625d" : "#a8a29e";
	return {
		darkMode: dark,
		background: t("--ds-surface", dark ? "#191918" : "#ffffff"),
		primaryColor: surface,
		primaryTextColor: text,
		primaryBorderColor: line,
		secondaryColor: t("--ds-surface-3", surface),
		tertiaryColor: t("--ds-surface", surface),
		lineColor: line,
		textColor: text,
		mainBkg: surface,
		nodeBorder: line,
		clusterBkg: t("--ds-surface", surface),
		actorBkg: surface,
		actorBorder: line,
		actorTextColor: text,
		actorLineColor: line,
		signalColor: text,
		signalTextColor: text,
		labelBoxBkgColor: surface,
		labelBoxBorderColor: line,
		labelTextColor: text,
		noteBkgColor: dark ? "#3a2a12" : "#fff1e3",
		noteBorderColor: dark ? "#8a5a1e" : "#f5b56f",
		noteTextColor: text,
		activationBkgColor: t("--ds-surface-3", surface),
		activationBorderColor: line,
	};
}

/**
 * Mermaid's SVG carries a <style> element (or its rules come held, see
 * holdStyles) and style="" attributes, which
 * `style-src 'self'` blocks once the SVG is inserted. Parse it in an inert
 * document, move both into a constructed stylesheet (CSSOM, allowed by CSP)
 * keyed by data attributes, and return the SVG without inline styles.
 */
const diagramSheets: CSSStyleSheet[] = [];
const MAX_SHEETS = 40;

/** Where renameStyles puts a tag's style="" before the SVG is parsed. */
const RENAMED_STYLE = "data-pulsar-css";

/** style="" → data-pulsar-css="", inside tags only (label text stays as is). */
function renameStyles(svg: string): string {
	return svg.replace(/<[a-zA-Z][^>]*>/g, (tag) =>
		tag.replace(/(\s)style=("[^"]*"|'[^']*')/g, `$1${RENAMED_STYLE}=$2`),
	);
}

function cspSafeSvg(svg: string, id: string, heldRules: string[] = []): string {
	try {
		// HTML parsing: Mermaid labels hold HTML (<br>) that strict XML rejects.
		// A DOMParser document is inert, so nothing is applied here; WebKit
		// still logs a refused style="" in it, so those are renamed first.
		const doc = new DOMParser().parseFromString(renameStyles(svg), "text/html");
		const root = doc.body.querySelector("svg");
		if (!root || !("adoptedStyleSheets" in document)) return svg;
		const sheet = new CSSStyleSheet();
		// Mermaid's own <style>: keep only parsed rules scoped to this diagram's
		// id, so diagram text can't add page-wide CSS (e.g. hide the approval card).
		const scope = `#${CSS.escape(root.id || id)}`;
		const styles = Array.from(root.querySelectorAll("style"));
		for (const css of [
			...heldRules,
			...styles.map((st) => st.textContent ?? ""),
		]) {
			const parsed = new CSSStyleSheet();
			try {
				parsed.replaceSync(css);
			} catch {}
			for (const rule of Array.from(parsed.cssRules)) {
				if (
					rule instanceof CSSStyleRule &&
					rule.selectorText.split(",").every((s) => s.trim().startsWith(scope))
				)
					sheet.insertRule(rule.cssText, sheet.cssRules.length);
			}
		}
		for (const st of styles) st.remove();
		// style="" attributes (renamed, or any renameStyles missed):
		// declarations only, set through CSSOM.
		let n = 0;
		const styled = `[style],[${RENAMED_STYLE}]`;
		for (const el of [root, ...Array.from(root.querySelectorAll(styled))]) {
			const css = [el.getAttribute(RENAMED_STYLE), el.getAttribute("style")]
				.filter(Boolean)
				.join(";");
			el.removeAttribute(RENAMED_STYLE);
			el.removeAttribute("style");
			if (!css) continue;
			const key = `${id}-${n++}`;
			el.setAttribute("data-pulsar-style", key);
			const i = sheet.insertRule(
				`[data-pulsar-style="${CSS.escape(key)}"]{}`,
				sheet.cssRules.length,
			);
			(sheet.cssRules[i] as CSSStyleRule).style.cssText = css;
		}
		diagramSheets.push(sheet);
		const dropped = diagramSheets.splice(
			0,
			Math.max(0, diagramSheets.length - MAX_SHEETS),
		);
		document.adoptedStyleSheets = [
			...document.adoptedStyleSheets.filter((s) => !dropped.includes(s)),
			sheet,
		];
		return root.outerHTML;
	} catch {
		return svg;
	}
}

/** KaTeX: loaded the first time a message contains math. */
let realMath: MathPlugin | null = null;
let mathLoading = false;
const MATH = /\$\$[\s\S]+?\$\$|(^|[^\\$\w])\$[^\s$][^$\n]*\$(?!\w)|\\\(|\\\[/;
function loadMath() {
	if (mathLoading) return;
	mathLoading = true;
	void Promise.all([
		import("@streamdown/math"),
		import("katex/dist/katex.min.css"),
	]).then(([m]) => {
		// `$x$` as well as `$$…$$`; dollarGuard keeps "$5 and $6" as text.
		const base = m.createMathPlugin({ singleDollarTextMath: true });
		realMath = {
			...base,
			remarkPlugin: { plugins: [base.remarkPlugin, dollarGuard] },
		} as unknown as MathPlugin;
		notify();
	});
}

/**
 * Props for every Streamdown in the transcript. Re-renders once KaTeX loads
 * (the first time `text` contains math).
 */
export function useSafeStreamdown(text: unknown): Partial<StreamdownProps> {
	const math = useSyncExternalStore(subscribe, () => realMath);
	if (!math && typeof text === "string" && MATH.test(text)) loadMath();
	return useMemo(
		() => ({
			plugins: math ? { mermaid, math } : { mermaid },
			rehypePlugins,
			components,
			// Plain links (see externalLinks), not Streamdown's confirm dialog.
			linkSafety: { enabled: false },
			controls: {
				table: false,
				mermaid: { copy: true, download: false, fullscreen: true },
			},
		}),
		[math],
	);
}

// ---------------------------------------------------------------- images

export type ApiImage = {
	src?: string;
	error?: "missing" | "too-large" | "type" | "failed";
};

/** The one API route transcript images and documents are served from. */
export const isTranscriptMedia = (pathname: string) =>
	/^\/api\/v1\/agents\/[^/]+\/transcript\/images\/[^/]+$/.test(pathname);

/**
 * Same-origin API images need the X-Pulsar header (a bare <img src> gets
 * 403), so fetch them into a blob: URL, revoked on unmount. The response's
 * Content-Type wins over the event's `mediaType`. 404 means the daemon no
 * longer knows the id: the session refetches its newest page.
 */
export function useApiImage(url: string | undefined): ApiImage {
	return useApiBlob(url, /^image\/(png|jpeg|gif|webp)$/);
}

/**
 * `useApiImage` for any allowed type: fetches an API URL into a blob: URL
 * when the response's type matches `allow`. Non-image blobs are revoked a
 * minute after unmount, so a tab opened from one can still load it.
 */
export function useApiBlob(url: string | undefined, allow: RegExp): ApiImage {
	const [state, setState] = useState<ApiImage>({});
	const source = allow.source;
	useEffect(() => {
		setState({});
		if (!url) return;
		const ok = new RegExp(source);
		let abs: URL;
		try {
			abs = new URL(url, location.href);
		} catch {
			return;
		}
		if (abs.origin !== location.origin) {
			setState({ error: "failed" });
			return;
		}
		if (!abs.pathname.startsWith("/api/")) {
			setState({ src: abs.href });
			return;
		}
		// Only the transcript media route: agent text must not make the app
		// fetch other API routes (an event stream never ends).
		if (!isTranscriptMedia(abs.pathname)) {
			setState({ error: "failed" });
			return;
		}
		let live = true;
		let blobUrl: string | undefined;
		const abort = new AbortController();
		fetch(abs.href, {
			headers: { [API_HEADER]: "1" },
			credentials: "omit",
			cache: "no-store",
			signal: abort.signal,
		})
			.then(async (r) => {
				if (!live) return;
				if (!r.ok) {
					if (r.status === 404)
						dispatchEvent(new Event("pulsar:transcript-stale"));
					setState({
						error:
							r.status === 404
								? "missing"
								: r.status === 413
									? "too-large"
									: r.status === 415
										? "type"
										: "failed",
					});
					return;
				}
				const b = await r.blob();
				if (!live) return;
				if (!ok.test(b.type)) {
					setState({ error: "type" });
					return;
				}
				blobUrl = URL.createObjectURL(b);
				setState({ src: blobUrl });
			})
			.catch(() => live && setState({ error: "failed" }));
		return () => {
			live = false;
			abort.abort();
			const done = blobUrl;
			if (!done) return;
			if (ok.test("image/png")) URL.revokeObjectURL(done);
			else setTimeout(() => URL.revokeObjectURL(done), 60_000);
		};
	}, [url, source]);
	return state;
}

export function ImageUnavailable({ why }: { why?: ApiImage["error"] }) {
	return (
		<span
			className="image-unavailable"
			role="img"
			aria-label="Image unavailable"
		>
			Image unavailable
			{why === "too-large"
				? " (over 10 MB)"
				: why === "type"
					? " (unsupported type)"
					: ""}
		</span>
	);
}

function MarkdownImage({
	src,
	alt,
	node: _node,
	...rest
}: ComponentProps<"img"> & { node?: unknown }) {
	const isBlobOrData =
		typeof src === "string" && /^(blob:|data:image\/)/.test(src);
	const fetched = useApiImage(
		isBlobOrData ? undefined : (src as string | undefined),
	);
	const finalSrc = isBlobOrData ? (src as string) : fetched.src;
	if (fetched.error) return <ImageUnavailable why={fetched.error} />;
	if (!finalSrc)
		return (
			<span className="md-image-pending">[image: {alt || "loading"}]</span>
		);
	return (
		<img
			{...rest}
			src={finalSrc}
			alt={alt ?? ""}
			className="h-auto max-w-full rounded-md"
			// Not lazy: blob: or data: bytes already in memory (see ImageThumb).
		/>
	);
}

export const components: StreamdownProps["components"] = {
	img: MarkdownImage,
	pre: (props) => {
		const [child] = props.node?.children ?? [];
		if (child?.type === "element" && child.tagName === "code") {
			const classes = child.properties.className;
			const lang = Array.isArray(classes)
				? classes
						.find((c) => typeof c === "string" && c.startsWith("language-"))
						?.toString()
						.slice(9)
				: undefined;
			if (
				lang !== "mermaid" &&
				child.children.every((part) => part.type === "text")
			) {
				return (
					<CodeBlock
						code={child.children.map((part) => part.value).join("")}
						lang={lang}
						className="ds-markdown-code"
					/>
				);
			}
		}
		return <defaultComponents.pre {...props} />;
	},
	// Not an HTML tag: the file references fileLinks makes.
	...({
		"file-ref": ({
			path,
			children,
		}: {
			path?: string;
			children?: ReactNode;
		}) => <FileRef path={path ?? ""}>{children}</FileRef>,
	} as StreamdownProps["components"]),
};
