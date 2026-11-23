/// <reference types="astro/client" />

/** Per-mode Ionic component styles (astro.config.mjs ionicModeStyles). */
declare module "virtual:ionic-css/*" {
	const css: Record<string, string>;
	export default css;
}

// @ionic/core ships ion-icon's custom element (ionicons) without types.
declare module "@ionic/core/components/ion-icon.js" {
	export function defineCustomElement(): void;
}
