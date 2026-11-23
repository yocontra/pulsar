// @ts-check
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const mockPort = Number(process.env.PULSAR_MOCK_PORT ?? 47337);

/**
 * Ionic (Stencil) adds the styles of its non-shadow components (header,
 * refresher, item-sliding, action sheet...) as a <style> in <head>, which the
 * CSP (style-src 'self') blocks. Register every component's styles as a
 * constructable stylesheet instead (document.adoptedStyleSheets, which CSP
 * does not restrict). The build fails if Stencil's code changes shape.
 */
function stencilConstructableStyles() {
	return {
		name: "stencil-constructable-styles",
		enforce: "pre",
		transform(code, id) {
			if (!/@ionic\/core\/components\/p-[\w-]+\.js$/.test(id)) return null;
			if (!code.includes("adoptedStyleSheets")) return null;
			// registerStyle(scopeId, cssText, allowConstructable): Stencil passes
			// "is shadow DOM" as the last argument.
			const calls = [
				...code.matchAll(/\b(\w+)\((\w+),(\w+),!!\(1&\w+\.i\)\)/g),
			];
			if (calls.length !== 1)
				throw new Error(
					`stencil-constructable-styles: expected one registerStyle call in ${id}, found ${calls.length}`,
				);
			const [all, fn, a, b] = calls[0];
			return code.replace(all, `${fn}(${a},${b},!0)`);
		},
	};
}

/**
 * @ionic/react defines a few wrappers (IonRouterOutlet, IonTabBar, IonNav,
 * IonIcon...) with top-level calls that aren't marked pure, and classes that
 * extend `React.Component` (a property read the bundler keeps), which keeps
 * their Ionic components (tabs, router outlet) in every bundle. Mark them pure
 * so unused ones tree-shake.
 */
function ionicReactPure() {
	return {
		name: "ionic-react-pure",
		enforce: "pre",
		transform(code, id) {
			if (!/@ionic\/react\/dist\/index\.js$/.test(id)) return null;
			const out =
				'import { Component as __RC, PureComponent as __RPC } from "react";\n' +
				code
					.replace(
						/^(const \w+ = )(createForwardRef|createReactComponent|React\.memo|React\.createContext)\(/gm,
						"$1/*@__PURE__*/ $2(",
					)
					// `extends React.Component` reads a property, which the bundler
					// must assume has side effects: every class would stay.
					.replace(/\bextends React\.Component\b/g, "extends __RC")
					.replace(/\bextends React\.PureComponent\b/g, "extends __RPC");
			if (out === code)
				throw new Error(
					"ionic-react-pure: no wrappers matched in @ionic/react",
				);
			return out;
		},
	};
}

/**
 * Ionic's components carry their styles for both modes (`ios`, `md`) as
 * strings in their JS. The phone picks one mode per device
 * (mobile/platform.ts), so each mode's strings move out of the components
 * into per-mode registries (`virtual:ionic-css/<mode>-<eager|lazy>`), and a
 * device downloads only its own. Each component's style getter reads the
 * registry (globalThis.__pulsarIonCss) when its first instance connects;
 * mobile/ionCss.ts loads the eager registry before the phone renders and
 * the lazy one with the after-first-paint Ionic module (lazyIonic.ts).
 *
 * A registry holds only the styles of components left in the bundle after
 * tree-shaking: its content is filled in at renderChunk, when every chunk's
 * rendered code is known (and before chunk hashes are computed). "lazy" is
 * what only the chunk holding mobile/ionic-lazy.tsx uses; everything else is "eager".
 * Build only: the dev server keeps the styles inline.
 */
function ionicModeStyles() {
	/** A JS string literal's value (Ionic's own minified build output). */
	const literal = (src) => new Function(`return ${src}`)();
	const PREFIX = "virtual:ionic-css/";
	const MARK = "__PULSAR_ION_CSS__";
	/** "ios:<key>" → CSS. */
	const css = new Map();
	let build = false;
	const str = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)/.source;
	const getter = new RegExp(
		`static get style\\(\\)\\{return\\{ios:${str},md:${str}\\}\\}`,
		"g",
	);
	return {
		name: "ionic-mode-styles",
		enforce: "pre",
		configResolved(c) {
			build = c.command === "build";
		},
		resolveId(id) {
			if (id.startsWith(PREFIX)) return `\0${id}`;
			return null;
		},
		load(id) {
			if (!id.startsWith(`\0${PREFIX}`)) return null;
			const which = id.slice(PREFIX.length + 1);
			if (!/^(ios|md)-(eager|lazy)$/.test(which))
				throw new Error(`ionic-mode-styles: unknown registry ${which}`);
			return build ? `export default "${MARK}${which}";` : "export default {};";
		},
		transform(code, id) {
			if (!build) return null;
			if (!/@ionic\/core\/components\/(ion|p)-[\w-]+\.js$/.test(id))
				return null;
			if (!code.includes("static get style(){return{ios:")) return null;
			const file = id.replace(/^.*\/components\//, "").replace(/\.js$/, "");
			let i = 0;
			const out = code.replace(getter, (_all, ios, md) => {
				const key = `${file}:${i++}`;
				css.set(`ios:${key}`, literal(ios));
				css.set(`md:${key}`, literal(md));
				const read = (m) =>
					`(globalThis.__pulsarIonCss?.["${m}:${key}"]??globalThis.__pulsarIonMiss?.("${m}:${key}")??"")`;
				// Getters: Stencil reads only the element's mode.
				return `static get style(){return{get ios(){return ${read("ios")}},get md(){return ${read("md")}}}}`;
			});
			if (i === 0)
				throw new Error(`ionic-mode-styles: no style getter matched in ${id}`);
			return out;
		},
		renderChunk(code, _chunk, _out, meta) {
			const m = new RegExp(`(["'\`])${MARK}((ios|md)-(eager|lazy))\\1`).exec(
				code,
			);
			if (!m) return null;
			const [, , , mode, part] = m;
			const used = { eager: new Set(), lazy: new Set() };
			for (const c of Object.values(meta.chunks)) {
				const lazy = c.moduleIds.some((id) =>
					/\/mobile\/ionic-lazy\.tsx$/.test(id),
				);
				for (const mod of Object.values(c.modules))
					for (const k of (mod.code ?? "").matchAll(
						/__pulsarIonCss\?\.\["ios:([^"]+)"\]/g,
					))
						used[lazy ? "lazy" : "eager"].add(k[1]);
			}
			for (const k of used.eager) used.lazy.delete(k);
			const map = {};
			for (const k of [...used[part]].sort())
				map[`${mode}:${k}`] = css.get(`${mode}:${k}`) ?? "";
			return code.replace(m[0], JSON.stringify(map));
		},
	};
}

/**
 * Sonner (toasts, src/lib/toast.ts) adds its stylesheet as a <style> in
 * <head> when its module loads, which the CSP (style-src 'self') blocks.
 * Drop that call; the toaster chunk imports `sonner/dist/styles.css`
 * instead (a real stylesheet). The build fails if Sonner's code changes shape.
 */
function sonnerNoInlineStyle() {
	return {
		name: "sonner-no-inline-style",
		enforce: "pre",
		transform(code, id) {
			if (!/node_modules\/sonner\/dist\/index\.mjs$/.test(id)) return null;
			const calls = code.match(/^__insertCSS\("(?:[^"\\]|\\.)*"\);$/gm) ?? [];
			if (calls.length !== 1)
				throw new Error(
					`sonner-no-inline-style: expected one __insertCSS call in ${id}, found ${calls.length}`,
				);
			return code.replace(calls[0], "");
		},
	};
}

// Static build into the npm package's dist/web. The page mounts React from a
// bundled module script (no `client:*` islands), so the output needs no inline
// scripts and runs under `script-src 'self'`; scripts/check-dist.ts enforces it.
export default defineConfig({
	output: "static",
	outDir: "../dist/web",
	integrations: [react()],
	devToolbar: { enabled: false },
	build: { inlineStylesheets: "never", assets: "_app" },
	vite: {
		plugins: [
			tailwindcss(),
			stencilConstructableStyles(),
			ionicReactPure(),
			ionicModeStyles(),
			sonnerNoInlineStyle(),
			// KaTeX fonts as woff2 only (every browser the app supports): drops
			// the woff and ttf copies, ~0.8 MB of the package.
			{
				name: "katex-woff2-only",
				enforce: "pre",
				transform(code, id) {
					if (!/katex(\.min)?\.css($|\?)/.test(id)) return null;
					return code.replace(
						/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g,
						"",
					);
				},
			},
		],
		resolve: {
			// One copy of tailwind-merge for Konsta, streamdown and lib/utils. An
			// install that keeps a stale nested copy (node_modules/streamdown/
			// node_modules/tailwind-merge) otherwise bundles it twice, and the
			// "konsta" chunk group below pulls the second copy into the eager
			// phone load (+2.2 KB gzipped, a different hash per checkout).
			dedupe: ["tailwind-merge"],
			alias: [
				// Radix scroll lock without an injected <style> (CSP has no
				// style-src); see src/lib/remove-scroll.tsx.
				{
					find: /^react-remove-scroll$/,
					replacement: fileURLToPath(
						new URL("./src/lib/remove-scroll.tsx", import.meta.url),
					),
				},
				// Common languages and two themes only (see src/lib/shiki.ts).
				{
					find: /^shiki$/,
					replacement: fileURLToPath(
						new URL("./src/lib/shiki.ts", import.meta.url),
					),
				},
				// rehype-katex parses KaTeX's HTML with `template.innerHTML` in the
				// browser build, which trips CSP `style-src-attr`. The parse5 build
				// (already bundled for rehype-raw) parses without touching the DOM.
				{
					find: /^hast-util-from-html-isomorphic$/,
					replacement: fileURLToPath(
						new URL(
							"../node_modules/hast-util-from-html-isomorphic/index.js",
							import.meta.url,
						),
					),
				},
			],
		},
		build: {
			assetsInlineLimit: 0,
			modulePreload: { polyfill: false },
			chunkSizeWarningLimit: 4000,
			rolldownOptions: {
				// Ionic's and Konsta's packages don't declare `sideEffects`, so
				// every component would ship (Konsta's set `displayName` at the
				// top level). Their component modules and wrappers only define
				// what is used. Ionic's components index only re-exports: as a side
				// effect it would pull IonNav's page transitions, the menu
				// controller and the like into the first route (~6 KB gzipped);
				// IonNav imports its transition when a page first animates.
				treeshake: {
					moduleSideEffects: (id) =>
						!/node_modules\/(@ionic\/core\/components\/(ion-[\w-]+|index)\.js|@ionic\/react\/dist\/index\.js|ionicons\/components\/|konsta\/(react|shared)\/)/.test(
							id,
						),
				},
			},
		},
		environments: {
			client: {
				build: {
					// One chunk for what every page load needs: React, the store and
					// router, and the tree both layouts share. Rolldown's default
					// splits these into many small shared chunks once lazy layouts
					// import them, which costs ~3 KB gzipped of import glue and lost
					// compression on the initial route.
					rolldownOptions: {
						output: {
							codeSplitting: {
								groups: [
									{
										name: "app",
										test: (id) =>
											/\/web\/src\/(main\.tsx|components\/(App\.tsx|treeRows\.ts)|lib\/(format|hash|lazy|router|signals|store)\.ts|api\/client\.ts)$/.test(
												id,
											) ||
											/node_modules\/(react|react-dom|scheduler)\//.test(id) ||
											/vite\/preload-helper/.test(id) ||
											// The page's entry script too: the lazy data layer imports
											// the store, so without this the entry is a one-line stub
											// that costs a round trip before "app" loads.
											/index\.astro\?astro&type=script/.test(id),
									},
									// Konsta UI's shared runtime (theme context and hooks, Glass,
									// cls with tailwind-merge) in one chunk: the tab bar loads it
									// with the phone, and lazy pages that use Konsta (Usage's
									// Segmented, Home's Searchbar) would otherwise split it into
									// several small shared chunks on the first route. Konsta's
									// components and their classes stay with whoever uses them.
									{
										name: "konsta",
										test: (id) =>
											/node_modules\/(konsta\/(react\/shared\/|shared\/(cls|filter-colors|touch-ripple-class|use-ios-highlight|use-ios-tabbar-highlight)\.js$|react\/components\/(Glass|NavbarContext|ToolbarContext)\.js$|shared\/(classes|colors)\/Glass)|tailwind-merge\/)/.test(
												id,
											),
									},
									// DOMPurify (Mermaid's only) under a stable name: the e2e
									// fixture names it among Mermaid's sources of WebKit CSP
									// reports (e2e/fixtures.ts). Loaded with Mermaid only.
									{
										name: "purify",
										test: /node_modules\/dompurify\//,
									},
								],
							},
						},
					},
				},
			},
		},
		server: {
			proxy: { "/api": { target: `http://127.0.0.1:${mockPort}` } },
		},
	},
});
