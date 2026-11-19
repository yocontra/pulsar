import {
	elementScroll,
	observeElementOffset,
	observeElementRect,
	Virtualizer,
	type VirtualizerOptions,
} from "@tanstack/virtual-core";
import { useLayoutEffect, useReducer, useState } from "react";

type Opts = Pick<
	VirtualizerOptions<HTMLElement, HTMLElement>,
	"count" | "getScrollElement" | "estimateSize" | "overscan" | "getItemKey"
> &
	Partial<VirtualizerOptions<HTMLElement, HTMLElement>>;

/** A small Preact hook around @tanstack/virtual-core. */
export function useVirtualizer(
	opts: Opts,
): Virtualizer<HTMLElement, HTMLElement> {
	const [, rerender] = useReducer((x: number) => x + 1, 0);
	const full: VirtualizerOptions<HTMLElement, HTMLElement> = {
		observeElementRect,
		observeElementOffset,
		scrollToFn: elementScroll,
		...opts,
		onChange: () => rerender(),
	};
	const [v] = useState(() => new Virtualizer(full));
	v.setOptions(full);
	useLayoutEffect(() => v._didMount(), [v]);
	useLayoutEffect(() => {
		v._willUpdate();
	});
	return v;
}
