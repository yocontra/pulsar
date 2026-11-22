/**
 * The phone's platform look: Material (Ionic `md`, Konsta `material`) on
 * Android, iOS everywhere else. `?platform=android|md|ios` in the URL forces
 * one (tests and screenshots). Read once at load: the Ionic mode can't
 * change without a reload.
 */
export type IonMode = "ios" | "md";

export function detectMode(
	search = location.search,
	ua = navigator.userAgent,
): IonMode {
	const forced = new URLSearchParams(search).get("platform");
	if (forced === "android" || forced === "md") return "md";
	if (forced === "ios") return "ios";
	return /\bAndroid\b/i.test(ua) ? "md" : "ios";
}

export const mode: IonMode = detectMode();
export const isMaterial = mode === "md";
