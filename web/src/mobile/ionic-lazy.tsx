/**
 * Ionic components that load after the phone's first paint. These wrap the
 * custom elements directly (the way @ionic/react builds its own wrappers), so
 * they stay out of the first route's chunk. See ionic.ts.
 */

import type {
	ItemSlidingCustomEvent,
	ModalBreakpointChangeEventDetail,
	RefresherEventDetail,
	ToggleChangeEventDetail,
} from "@ionic/core";
import {
	type ActionSheetButton,
	actionSheetController,
	toastController,
} from "@ionic/core/components";
import {
	IonActionSheet as ActionSheetEl,
	defineCustomElement as defineActionSheet,
} from "@ionic/core/components/ion-action-sheet.js";
import {
	defineCustomElement as defineFooter,
	IonFooter as FooterEl,
} from "@ionic/core/components/ion-footer.js";
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
	defineCustomElement as defineLabel,
	IonLabel as LabelEl,
} from "@ionic/core/components/ion-label.js";
import {
	defineCustomElement as defineList,
	IonList as ListEl,
} from "@ionic/core/components/ion-list.js";
import {
	defineCustomElement as defineListHeader,
	IonListHeader as ListHeaderEl,
} from "@ionic/core/components/ion-list-header.js";
import {
	defineCustomElement as defineModal,
	IonModal as ModalEl,
} from "@ionic/core/components/ion-modal.js";
import {
	defineCustomElement as defineNote,
	IonNote as NoteEl,
} from "@ionic/core/components/ion-note.js";
import {
	defineCustomElement as defineRefresher,
	IonRefresher as RefresherEl,
} from "@ionic/core/components/ion-refresher.js";
import {
	defineCustomElement as defineRefresherContent,
	IonRefresherContent as RefresherContentEl,
} from "@ionic/core/components/ion-refresher-content.js";
import {
	defineCustomElement as defineSearchbar,
	IonSearchbar as SearchbarEl,
} from "@ionic/core/components/ion-searchbar.js";
import {
	defineCustomElement as defineSpinner,
	IonSpinner as SpinnerEl,
} from "@ionic/core/components/ion-spinner.js";
import {
	defineCustomElement as defineTextarea,
	IonTextarea as TextareaEl,
} from "@ionic/core/components/ion-textarea.js";
import {
	defineCustomElement as defineToast,
	IonToast as ToastEl,
} from "@ionic/core/components/ion-toast.js";
import {
	defineCustomElement as defineToggle,
	IonToggle as ToggleEl,
} from "@ionic/core/components/ion-toggle.js";
import { createComponent } from "@stencil/react-output-target/runtime";
import React from "react";

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
export const IonRefresher = createComponent<
	InstanceType<typeof RefresherEl>,
	{ onIonRefresh: string }
>({
	tagName: "ion-refresher",
	elementClass: RefresherEl,
	react: React,
	events: { onIonRefresh: "ionRefresh" },
	defineCustomElement: defineRefresher,
});
export const IonRefresherContent = createComponent<
	InstanceType<typeof RefresherContentEl>
>({
	tagName: "ion-refresher-content",
	elementClass: RefresherContentEl,
	react: React,
	events: {},
	defineCustomElement: defineRefresherContent,
});
export const IonToggle = createComponent<
	InstanceType<typeof ToggleEl>,
	{ onIonChange: string }
>({
	tagName: "ion-toggle",
	elementClass: ToggleEl,
	react: React,
	events: { onIonChange: "ionChange" },
	defineCustomElement: defineToggle,
});
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

export const IonSearchbar = createComponent<
	InstanceType<typeof SearchbarEl>,
	{
		onIonInput: string;
		onIonChange: string;
		onIonClear: string;
		onIonCancel: string;
		onIonFocus: string;
		onIonBlur: string;
	}
>({
	tagName: "ion-searchbar",
	elementClass: SearchbarEl,
	react: React,
	events: {
		onIonInput: "ionInput",
		onIonChange: "ionChange",
		onIonClear: "ionClear",
		onIonCancel: "ionCancel",
		onIonFocus: "ionFocus",
		onIonBlur: "ionBlur",
	},
	defineCustomElement: defineSearchbar,
});
export const IonList = createComponent<InstanceType<typeof ListEl>>({
	tagName: "ion-list",
	elementClass: ListEl,
	react: React,
	events: {},
	defineCustomElement: defineList,
});
export const IonListHeader = createComponent<InstanceType<typeof ListHeaderEl>>(
	{
		tagName: "ion-list-header",
		elementClass: ListHeaderEl,
		react: React,
		events: {},
		defineCustomElement: defineListHeader,
	},
);
export const IonLabel = createComponent<InstanceType<typeof LabelEl>>({
	tagName: "ion-label",
	elementClass: LabelEl,
	react: React,
	events: {},
	defineCustomElement: defineLabel,
});
export const IonNote = createComponent<InstanceType<typeof NoteEl>>({
	tagName: "ion-note",
	elementClass: NoteEl,
	react: React,
	events: {},
	defineCustomElement: defineNote,
});
export const IonFooter = createComponent<InstanceType<typeof FooterEl>>({
	tagName: "ion-footer",
	elementClass: FooterEl,
	react: React,
	events: {},
	defineCustomElement: defineFooter,
});
export const IonTextarea = createComponent<
	InstanceType<typeof TextareaEl>,
	{
		onIonInput: string;
		onIonChange: string;
		onIonFocus: string;
		onIonBlur: string;
	}
>({
	tagName: "ion-textarea",
	elementClass: TextareaEl,
	react: React,
	events: {
		onIonInput: "ionInput",
		onIonChange: "ionChange",
		onIonFocus: "ionFocus",
		onIonBlur: "ionBlur",
	},
	defineCustomElement: defineTextarea,
});
export const IonSpinner = createComponent<InstanceType<typeof SpinnerEl>>({
	tagName: "ion-spinner",
	elementClass: SpinnerEl,
	react: React,
	events: {},
	defineCustomElement: defineSpinner,
});

// Controller overlays (created imperatively) need their elements defined.
defineActionSheet();
defineToast();
void ActionSheetEl;
void ToastEl;

export type {
	ActionSheetButton,
	ItemSlidingCustomEvent,
	ModalBreakpointChangeEventDetail,
	RefresherEventDetail,
	ToggleChangeEventDetail,
};
export { actionSheetController, toastController };
