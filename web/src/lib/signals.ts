import { type FC, useLayoutEffect, useReducer } from "react";

/**
 * A tiny signals store for React (the app used @preact/signals before).
 * `signal.value` reads are tracked while an `observer` component renders,
 * and the component re-renders when any signal it read changes.
 */
type Listener = () => void;

interface Readable<T> {
	readonly value: T;
	peek(): T;
}

let tracking: Set<Signal<unknown>> | null = null;

export class Signal<T> implements Readable<T> {
	private v: T;
	private listeners = new Set<Listener>();
	constructor(v: T) {
		this.v = v;
	}
	get value(): T {
		tracking?.add(this as Signal<unknown>);
		return this.v;
	}
	set value(next: T) {
		if (Object.is(next, this.v)) return;
		this.v = next;
		for (const l of [...this.listeners]) l();
	}
	peek(): T {
		return this.v;
	}
	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
}

export function signal<T>(v: T): Signal<T> {
	return new Signal(v);
}

/** Derived value; recomputed on read, so its inputs are tracked by the reader. */
export function computed<T>(fn: () => T): Readable<T> {
	return {
		get value() {
			return fn();
		},
		peek() {
			const prev = tracking;
			tracking = null;
			try {
				return fn();
			} finally {
				tracking = prev;
			}
		},
	};
}

function track<T>(fn: () => T): { result: T; deps: Set<Signal<unknown>> } {
	const prev = tracking;
	const deps = new Set<Signal<unknown>>();
	tracking = deps;
	try {
		return { result: fn(), deps };
	} finally {
		tracking = prev;
	}
}

/** Run `fn` now and again (batched in a microtask) whenever a signal it read changes. */
export function effect(fn: () => void): () => void {
	let unsubs: (() => void)[] = [];
	let queued = false;
	let disposed = false;
	const run = () => {
		queued = false;
		if (disposed) return;
		for (const u of unsubs) u();
		const { deps } = track(fn);
		unsubs = [...deps].map((d) =>
			d.subscribe(() => {
				if (queued) return;
				queued = true;
				queueMicrotask(run);
			}),
		);
	};
	run();
	return () => {
		disposed = true;
		for (const u of unsubs) u();
	};
}

/** Re-render a component when the signals it read during render change. */
export function observer<P extends object>(
	Component: (props: P) => React.ReactNode,
): FC<P> {
	function Observed(props: P) {
		const [, force] = useReducer((x: number) => x + 1, 0);
		const { result, deps } = track(() => Component(props));
		useLayoutEffect(() => {
			const unsubs = [...deps].map((d) => d.subscribe(force));
			return () => {
				for (const u of unsubs) u();
			};
		});
		return result;
	}
	Observed.displayName = Component.name || "Observed";
	return Observed;
}
