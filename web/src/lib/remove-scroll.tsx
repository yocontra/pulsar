/**
 * CSP-safe stand-in for `react-remove-scroll`, aliased in astro.config.mjs.
 *
 * Radix (Dialog, Menu, Popover, Select) locks page scroll with
 * react-remove-scroll, which injects a `<style>` element. The daemon's CSP
 * has no `style-src` (it falls back to `default-src 'self'`), so the browser
 * blocks that element and logs a violation. This shim keeps Radix's API
 * (`as`, `enabled`, `shards`, ...) and locks scroll through CSSOM instead,
 * which CSP allows. The app shell never scrolls the document, so locking the
 * root's overflow is enough.
 */
import {
	type ComponentType,
	createElement,
	forwardRef,
	type ReactNode,
	useEffect,
} from "react";

let locks = 0;
let saved = "";

function lock() {
	if (locks++ === 0) {
		saved = document.documentElement.style.overflow;
		document.documentElement.style.overflow = "hidden";
	}
}

function unlock() {
	if (--locks === 0) document.documentElement.style.overflow = saved;
}

interface Props {
	as?: ComponentType<Record<string, unknown>> | string;
	enabled?: boolean;
	children?: ReactNode;
	// Accepted for API compatibility; scrolling inside layers is native.
	allowPinchZoom?: boolean;
	shards?: unknown;
	removeScrollBar?: boolean;
	inert?: boolean;
	noIsolation?: boolean;
	noRelative?: boolean;
	forwardProps?: boolean;
	gapMode?: string;
	className?: string;
	[key: string]: unknown;
}

const RemoveScrollImpl = forwardRef<HTMLElement, Props>(
	function RemoveScroll(props, ref) {
		const {
			as = "div",
			enabled = true,
			allowPinchZoom: _a,
			shards: _s,
			removeScrollBar: _r,
			inert: _i,
			noIsolation: _n,
			noRelative: _nr,
			forwardProps: _f,
			gapMode: _g,
			children,
			...rest
		} = props;
		useEffect(() => {
			if (!enabled) return;
			lock();
			return unlock;
		}, [enabled]);
		return createElement(as as string, { ...rest, ref }, children as ReactNode);
	},
);

export const RemoveScroll = Object.assign(RemoveScrollImpl, {
	classNames: { fullWidth: "", zeroRight: "" },
});
export default RemoveScroll;
