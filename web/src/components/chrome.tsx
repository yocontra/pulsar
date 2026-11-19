import { useEffect, useState } from "react";
import type { FailureKind } from "../api/client.ts";
import { lazy } from "../lib/lazy.tsx";
import { observer, signal } from "../lib/signals.ts";
import { filter, resetTree } from "../lib/store.ts";
import { Search, SfClear, SfSearch } from "./icons.tsx";

/** Layers draw nothing while their chunk loads (no stray spinner on top). */
const none = () => <span hidden />;
const LAYER = { layer: true };

export const SessionView = lazy(() => import("../session/SessionView.tsx"));
export const Builder = lazy(
	() => import("../builder/Builder.tsx"),
	none,
	LAYER,
);
export const ApprovalCard = lazy(() => import("../approval/ApprovalCard.tsx"));
export const Palette = lazy(() => import("./Palette.tsx"), none, LAYER);
// The scoped composer pulls in PromptInput; keep it off the first route.
export const ScopeView = lazy<{ id: string; mobile: boolean }>(() =>
	import("./ScopeView.tsx").then((m) => ({ default: m.ScopeView })),
);
export const IdsView = lazy<{ ids: string[]; mobile: boolean }>(() =>
	import("./ScopeView.tsx").then((m) => ({ default: m.IdsView })),
);
// Screens that aren't the tree: failure, first run, needs-you list, help, QR.
export const screens = () => import("./Screens.tsx");
export const FailureScreen = lazy<{ kind: FailureKind; detail?: string }>(() =>
	screens().then((m) => ({ default: m.FailureScreen })),
);
export const FirstRun = lazy<{ onQr: () => void }>(() =>
	screens().then((m) => ({ default: m.FirstRun })),
);
export const NeedsList = lazy<{ mobile: boolean }>(() =>
	screens().then((m) => ({ default: m.NeedsList })),
);
export const Help = lazy<{ onClose: () => void }>(
	() => screens().then((m) => ({ default: m.Help })),
	none,
	LAYER,
);
export const QrModal = lazy<{ onClose: () => void }>(
	() => import("../qr/QrModal.tsx"),
	none,
	LAYER,
);

/** Settings: passkeys and notifications (lazy: WebAuthn/push code stays off the first route). */
export const SettingsModal = lazy<{ onClose: () => void }>(
	() => import("../settings/Settings.tsx"),
	none,
	LAYER,
);

export const showQr = signal(false);
export const showSettings = signal(false);
export const showHelp = signal(false);
export const showPalette = signal(false);

function FilterBoxImpl({ mobile }: { mobile: boolean }) {
	const [text, setText] = useState(filter.value);
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => {
			if (text !== filter.value) {
				filter.value = text;
				resetTree();
			}
		}, 250);
		return () => clearTimeout(t);
	}, [text]);
	if (mobile)
		return (
			<div className="m-search-row">
				<label className="search-box">
					<SfSearch size={17} />
					<input
						id="filter"
						type="search"
						enterKeyHint="search"
						value={text}
						placeholder="Machines, projects, agents"
						aria-label="Filter the tree"
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="none"
						spellCheck={false}
						onFocus={() => setFocused(true)}
						onBlur={() => setFocused(false)}
						onChange={(e) => setText((e.target as HTMLInputElement).value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
					/>
					{text && (
						<button
							type="button"
							className="m-clear"
							aria-label="Clear search"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => setText("")}
						>
							<SfClear size={17} />
						</button>
					)}
				</label>
				{(focused || text) && (
					<button
						type="button"
						className="m-cancel"
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => {
							setText("");
							(document.activeElement as HTMLElement | null)?.blur();
						}}
					>
						Cancel
					</button>
				)}
			</div>
		);
	return (
		<label className="search-box">
			<Search size={14} />
			<input
				id="filter"
				type="search"
				value={text}
				placeholder="Filter: machine, project, ~text"
				aria-label="Filter the tree"
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => setText((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setText("");
						(e.target as HTMLInputElement).blur();
					}
				}}
			/>
		</label>
	);
}

export const FilterBox = observer(FilterBoxImpl);
