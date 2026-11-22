/**
 * A number an end-to-end test's init script set on `window.__pulsarE2E`
 * (never set otherwise), so a test can shorten a wait instead of racing it.
 */
export function e2eNumber(name: string): number | null {
	const e2e = (globalThis as { __pulsarE2E?: Record<string, unknown> })
		.__pulsarE2E;
	const v = e2e?.[name];
	return typeof v === "number" && v >= 0 ? v : null;
}
