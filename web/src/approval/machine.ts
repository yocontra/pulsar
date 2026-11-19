import { hello } from "../lib/store.ts";

/** The app on another machine of the pool, opened on its Prove Human page (#/prove). */
export function machineUrl(machine: string): string | null {
	const url = hello.peek()?.appUrl;
	if (!url) return null;
	try {
		const u = new URL(url);
		const rest = u.hostname.split(".").slice(1).join(".");
		if (!rest) return null;
		u.hostname = `${machine.toLowerCase()}.${rest}`;
		u.hash = "#/prove";
		return u.toString();
	} catch {
		return null;
	}
}
