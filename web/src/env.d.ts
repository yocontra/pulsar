/// <reference types="astro/client" />

/** Per-mode Ionic component styles (astro.config.mjs ionicModeStyles). */
declare module "virtual:ionic-css/*" {
	const css: Record<string, string>;
	export default css;
}
