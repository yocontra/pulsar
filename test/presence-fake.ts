import type {
	PresenceOutcome,
	PresenceProvider,
} from "../src/presence/native.ts";
import type { Caller, Principal } from "../src/service/caller.ts";

/**
 * A scripted OS prompt for tests: answers with the next outcome in `script`
 * (or `hang` until aborted), and records every reason it was shown.
 */
export class FakePresence implements PresenceProvider {
	readonly method = "Touch ID";
	readonly shown: string[] = [];
	aborted = 0;
	ok = true;
	script: (PresenceOutcome | "hang")[];

	constructor(...script: (PresenceOutcome | "hang")[]) {
		this.script = script;
	}

	async available() {
		return this.ok;
	}

	verify(reason: string, o: { signal: AbortSignal }): Promise<PresenceOutcome> {
		this.shown.push(reason);
		const next = this.script.shift() ?? "denied";
		if (next !== "hang") return Promise.resolve(next);
		return new Promise((resolve) => {
			const done = () => {
				this.aborted++;
				resolve("timeout");
			};
			if (o.signal.aborted) done();
			else o.signal.addEventListener("abort", done, { once: true });
		});
	}
}

/** A socket caller for `principal`, with the events it was sent and a way to hang up. */
export function fakeCaller(principal: Principal) {
	const ac = new AbortController();
	const events: { event: string; data: unknown }[] = [];
	const caller: Caller = {
		principal,
		closed: ac.signal,
		emit: (event, data) => events.push({ event, data }),
	};
	return { caller, events, hangUp: () => ac.abort() };
}
