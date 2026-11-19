import {
	type ComponentProps,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { harden } from "rehype-harden";
import {
	type CodeHighlighterPlugin,
	type DiagramPlugin,
	defaultRehypePlugins,
	type MathPlugin,
	type StreamdownProps,
} from "streamdown";
import { API_HEADER } from "../api/types.ts";
import "streamdown/styles.css";
import { dollarGuard } from "./dollars.ts";

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
	defaultRehypePlugins.sanitize!,
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
	type El = {
		type: string;
		tagName?: string;
		value?: string;
		properties?: Record<string, unknown>;
		children?: El[];
	};
	const walk = (n: El) => {
		const href = n.properties?.href;
		if (n.type === "element" && n.tagName === "a" && href) {
			if (allowedLink(String(href))) {
				n.properties!.target = "_blank";
				n.properties!.rel = ["noopener", "noreferrer"];
			} else {
				n.tagName = "span";
				n.properties = { title: "Blocked URL", className: ["text-gray-500"] };
				n.children = [
					...(n.children ?? []),
					{ type: "text", value: " [blocked]" },
				];
			}
		}
		for (const c of n.children ?? []) walk(c);
	};
	return (tree: El) => walk(tree);
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

/** Shiki: tokens arrive through the callback once the highlighter chunk loads. */
let realCode: CodeHighlighterPlugin | null = null;
let codeLoading: Promise<CodeHighlighterPlugin> | null = null;
const loadCode = () => {
	codeLoading ??= import("@streamdown/code").then((m) => {
		realCode = m.code as unknown as CodeHighlighterPlugin;
		return realCode;
	});
	return codeLoading;
};
const code: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	getSupportedLanguages: () => realCode?.getSupportedLanguages() ?? [],
	getThemes: () => realCode?.getThemes() ?? ["pulsar", "pulsar"],
	supportsLanguage: (lang) =>
		realCode ? realCode.supportsLanguage(lang) : true,
	highlight(options, callback) {
		if (realCode) return realCode.highlight(options, callback);
		void loadCode().then((c) => {
			if (!c.supportsLanguage(options.language)) return;
			const r = c.highlight(options, callback);
			if (r && callback) callback(r);
		});
		return null;
	},
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
				const out = await m.render(id, source);
				return { svg: cspSafeSvg(out.svg, id) };
			},
		};
	},
};

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
 * Mermaid's SVG carries a <style> element and style="" attributes, which
 * `style-src 'self'` blocks once the SVG is inserted. Parse it in an inert
 * document, move both into a constructed stylesheet (CSSOM, allowed by CSP)
 * keyed by data attributes, and return the SVG without inline styles.
 */
const diagramSheets: CSSStyleSheet[] = [];
const MAX_SHEETS = 40;

function cspSafeSvg(svg: string, id: string): string {
	try {
		// HTML parsing: Mermaid labels hold HTML (<br>) that strict XML rejects.
		// A DOMParser document is inert and has no CSP, so nothing is applied here.
		const doc = new DOMParser().parseFromString(svg, "text/html");
		const root = doc.body.querySelector("svg");
		if (!root || !("adoptedStyleSheets" in document)) return svg;
		const sheet = new CSSStyleSheet();
		// Mermaid's own <style>: keep only parsed rules scoped to this diagram's
		// id, so diagram text can't add page-wide CSS (e.g. hide the approval card).
		const scope = `#${CSS.escape(root.id || id)}`;
		for (const st of Array.from(root.querySelectorAll("style"))) {
			const parsed = new CSSStyleSheet();
			try {
				parsed.replaceSync(st.textContent ?? "");
			} catch {}
			for (const rule of Array.from(parsed.cssRules)) {
				if (
					rule instanceof CSSStyleRule &&
					rule.selectorText.split(",").every((s) => s.trim().startsWith(scope))
				)
					sheet.insertRule(rule.cssText, sheet.cssRules.length);
			}
			st.remove();
		}
		// style="" attributes: declarations only, set through CSSOM.
		let n = 0;
		for (const el of [root, ...Array.from(root.querySelectorAll("[style]"))]) {
			if (!el.hasAttribute("style")) continue;
			const key = `${id}-${n++}`;
			el.setAttribute("data-pulsar-style", key);
			const i = sheet.insertRule(
				`[data-pulsar-style="${CSS.escape(key)}"]{}`,
				sheet.cssRules.length,
			);
			(sheet.cssRules[i] as CSSStyleRule).style.cssText =
				el.getAttribute("style") ?? "";
			el.removeAttribute("style");
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
			plugins: math ? { code, mermaid, math } : { code, mermaid },
			rehypePlugins,
			components,
			// Plain links (see externalLinks), not Streamdown's confirm dialog.
			linkSafety: { enabled: false },
			// Presentation only: the app's CSS-variable code theme (both schemes),
			// copy without download, no line numbers in prose code.
			shikiTheme: ["pulsar", "pulsar"],
			controls: {
				code: { copy: true, download: false },
				table: false,
				mermaid: { copy: true, download: false, fullscreen: true },
			},
			lineNumbers: false,
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
			loading="lazy"
		/>
	);
}

export const components: StreamdownProps["components"] = { img: MarkdownImage };
