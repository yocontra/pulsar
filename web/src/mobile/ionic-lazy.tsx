/**
 * Ionic components that load after the phone's first paint. These wrap the
 * custom elements directly (the way @ionic/react builds its own wrappers), so
 * they stay out of the first route's chunk. See ionic.ts.
 */

import { defineCustomElement as defineIcon } from "@ionic/core/components/ion-icon.js";
import {
	defineCustomElement as defineItemOption,
	IonItemOption as ItemOptionEl,
} from "@ionic/core/components/ion-item-option.js";
import {
	defineCustomElement as defineItemOptions,
	IonItemOptions as ItemOptionsEl,
} from "@ionic/core/components/ion-item-options.js";
import {
	defineCustomElement as defineItemSliding,
	IonItemSliding as ItemSlidingEl,
} from "@ionic/core/components/ion-item-sliding.js";
import {
	defineCustomElement as defineModal,
	IonModal as ModalEl,
} from "@ionic/core/components/ion-modal.js";
import { createComponent } from "@stencil/react-output-target/runtime";
import React from "react";

// IonNav imports its page transition when a page first animates. Named here
// so prefetching this module warms it, and the first push doesn't wait on it.
export {
	iosTransitionAnimation,
	mdTransitionAnimation,
} from "@ionic/core/components";

// IonItem's `detail` chevron is an ion-icon, which IonItem doesn't register
// (the same module @ionic/react's IonIcon uses, so nothing is bundled twice).
defineIcon();

export const IonItemSliding = createComponent<
	InstanceType<typeof ItemSlidingEl>,
	{ onIonDrag: string }
>({
	tagName: "ion-item-sliding",
	elementClass: ItemSlidingEl,
	react: React,
	events: { onIonDrag: "ionDrag" },
	defineCustomElement: defineItemSliding,
});
export const IonItemOptions = createComponent<
	InstanceType<typeof ItemOptionsEl>,
	{ onIonSwipe: string }
>({
	tagName: "ion-item-options",
	elementClass: ItemOptionsEl,
	react: React,
	events: { onIonSwipe: "ionSwipe" },
	defineCustomElement: defineItemOptions,
});
export const IonItemOption = createComponent<InstanceType<typeof ItemOptionEl>>(
	{
		tagName: "ion-item-option",
		elementClass: ItemOptionEl,
		react: React,
		events: {},
		defineCustomElement: defineItemOption,
	},
);
export const IonModal = createComponent<
	InstanceType<typeof ModalEl>,
	{
		onIonModalDidDismiss: string;
		onIonModalWillDismiss: string;
		onIonModalDidPresent: string;
		onIonBreakpointDidChange: string;
	}
>({
	tagName: "ion-modal",
	elementClass: ModalEl,
	react: React,
	events: {
		onIonModalDidDismiss: "ionModalDidDismiss",
		onIonModalWillDismiss: "ionModalWillDismiss",
		onIonModalDidPresent: "ionModalDidPresent",
		onIonBreakpointDidChange: "ionBreakpointDidChange",
	},
	defineCustomElement: defineModal,
});
