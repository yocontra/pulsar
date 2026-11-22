/**
 * Action sheets (Konsta Actions): long-press menus and confirms. The
 * imperative `showActions` takes the options Ionic's actionSheetController
 * took, so call sites only swap the call. ActionsHost (PhoneApp) renders the
 * open sheet; its Konsta chunk loads with the first sheet.
 */
import { signal } from "../../lib/signals.ts";

export interface ActionButton {
	text: string;
	/** "destructive" is red; "cancel" sits apart and closes the sheet. */
	role?: "destructive" | "cancel";
	handler?: () => void;
	disabled?: boolean;
}

export interface ActionsOptions {
	header?: string;
	subHeader?: string;
	buttons: ActionButton[];
}

export interface ActionsRequest extends ActionsOptions {
	id: number;
	done: () => void;
}

/** The open action sheet, if any (ActionsHost renders it). */
export const actionsRequest = signal<ActionsRequest | null>(null);

let next = 0;

/** Show an action sheet; resolves once it is dismissed. */
export function showActions(opts: ActionsOptions): Promise<void> {
	actionsRequest.peek()?.done();
	return new Promise((resolve) => {
		const id = ++next;
		actionsRequest.value = {
			...opts,
			id,
			done: () => {
				if (actionsRequest.peek()?.id === id) actionsRequest.value = null;
				resolve();
			},
		};
	});
}
