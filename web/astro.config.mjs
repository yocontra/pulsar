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
 * The phone runs Ionic in iOS mode only: drop each component's Material
 * (`md`) stylesheet from the bundle.
 */
function ionicIosOnly() {
	return {
		name: "ionic-ios-only",
		enforce: "pre",
		transform(code, id) {
			if (!/@ionic\/core\/components\/(ion|p)-[\w-]+\.js$/.test(id))
				return null;
			if (!code.includes("static get style(){return{ios:")) return null;
			return code.replace(
				/,md:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g,
				"",
			);
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
			ionicIosOnly(),
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
				// Ionic's packages don't declare `sideEffects`, so every component
				// would ship. Their component modules and wrappers only define
				// what is used.
				treeshake: {
					moduleSideEffects: (id) =>
						!/node_modules\/(@ionic\/core\/components\/ion-[\w-]+\.js|@ionic\/react\/dist\/index\.js|ionicons\/components\/)/.test(
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
