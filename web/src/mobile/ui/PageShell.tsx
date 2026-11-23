/**
 * A phone page: its top bar and its scroll area (Ionic's IonHeader and
 * IonContent, as direct children of IonNav's page, so the iOS push moves the
 * titles), with Konsta inside.
 *
 * - iOS: a large title that condenses into the bar as the page scrolls
 *   (IonHeader collapse="condense"), and a Liquid Glass bar: Konsta's
 *   navbar backdrop (a surface-to-clear gradient over a light blur) with
 *   the trailing buttons in a glass capsule.
 * - Android: Material's top app bar (back arrow, title, icon buttons).
 *
 * A tab's root (TabShell) shows no title: see there.
 *
 * Safe areas come from Ionic (the header and content pad for --sat/--sab):
 * nothing inside adds Konsta's pt-safe/pb-safe on top.
 */
import { Glass } from "konsta/react";
import type { ReactNode } from "react";
import type { Route } from "../../lib/router.ts";
import { BackButton } from "../BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "../ionic.ts";
import { isMaterial } from "../platform.ts";

export interface PageShellProps {
	/** The bar's title (and the large title on iOS). */
	title: string;
	/** A second line under the bar's title (not the large title). */
	subtitle?: string;
	/** This page's route: the back button (none on a tab's root). */
	route?: Route;
	/** Leading buttons after the back button. */
	start?: ReactNode;
	/** Trailing buttons: a glass capsule on iOS, icon buttons on Android. */
	end?: ReactNode;
	/** Under the title (a search field): under the iOS large title, where
	 * it scrolls away with it; at the top of the content on Android. */
	below?: ReactNode;
	/** iOS large title (default on). */
	large?: boolean;
	/** The content scrolls (default); off for a page that lays out its own
	 * scroller (a draft with its composer at the bottom). */
	scrollY?: boolean;
	/** The scroll area's class (page styles). */
	className?: string;
	/** A fixed footer under the content (a composer dock). */
	footer?: ReactNode;
	testId?: string;
	children: ReactNode;
}

export function PageShell({
	title,
	subtitle,
	route,
	start,
	end,
	below,
	large = true,
	scrollY = true,
	className,
	footer,
	testId,
	children,
}: PageShellProps) {
	const condense = large && !isMaterial;
	return (
		<>
			<IonHeader translucent={!isMaterial} className="p-bar">
				{!isMaterial && (
					<div
						aria-hidden="true"
						className="p-bar-bg bg-gradient-to-b from-ios-light-surface to-transparent dark:from-ios-dark-surface/50 backdrop-blur-[2px] mask-b-from-50% mask-b-to-100%"
					/>
				)}
				<IonToolbar>
					{(route || start) && (
						<IonButtons slot="start">
							{route && <BackButton route={route} />}
							{start}
						</IonButtons>
					)}
					<IonTitle>
						{subtitle ? (
							<span className="p-nav-title">
								<h1>{title}</h1>
								<span className="p-nav-sub">{subtitle}</span>
							</span>
						) : (
							title
						)}
					</IonTitle>
					{end && (
						<IonButtons slot="end">
							{isMaterial ? (
								end
							) : (
								<Glass highlight={false} className="p-bar-glass">
									{end}
								</Glass>
							)}
						</IonButtons>
					)}
				</IonToolbar>
			</IonHeader>
			<IonContent
				fullscreen
				scrollY={scrollY}
				className={className ? `p-page ${className}` : "p-page"}
				data-testid={testId}
			>
				{condense && (
					<IonHeader collapse="condense">
						<IonToolbar>
							<IonTitle size="large">{title}</IonTitle>
						</IonToolbar>
						{below && <IonToolbar className="p-bar-below">{below}</IonToolbar>}
					</IonHeader>
				)}
				{!condense && below && <div className="p-bar-below">{below}</div>}
				{children}
			</IonContent>
			{footer}
		</>
	);
}

/** A tab root's props: `below` is the row's main control (a search field),
 * filling the row with the end buttons beside it. */
export type TabShellProps = Omit<PageShellProps, "route">;

/**
 * A tab's root page (tabs.ts): no title on screen, as the tab bar already
 * says where you are. Its controls (`below`, `start`, `end`) sit in one slim
 * row under the status bar; with none, there is no bar and the content
 * starts under the status bar, over a scrim of the page color (= theme
 * color). `title` names the page for screen readers; `large` and
 * `subtitle` are ignored.
 */
export function TabShell({
	title,
	start,
	end,
	below,
	scrollY = true,
	className,
	footer,
	testId,
	children,
}: TabShellProps) {
	const row = !!(below || start || end);
	const cls = ["p-page", "p-tab-root", row ? "" : "p-tab-bare", className]
		.filter(Boolean)
		.join(" ");
	return (
		<>
			{row && (
				<IonHeader translucent={!isMaterial} className="p-bar p-tab-bar">
					{!isMaterial && (
						<div
							aria-hidden="true"
							className="p-bar-bg bg-gradient-to-b from-ios-light-surface to-transparent dark:from-ios-dark-surface/50 backdrop-blur-[2px] mask-b-from-50% mask-b-to-100%"
						/>
					)}
					<IonToolbar>
						<div className="p-tab-row">
							{start}
							<div className="p-tab-row-main">{below}</div>
							{end && (
								<IonButtons className="p-tab-row-end">
									{isMaterial ? (
										end
									) : (
										<Glass highlight={false} className="p-bar-glass">
											{end}
										</Glass>
									)}
								</IonButtons>
							)}
						</div>
					</IonToolbar>
				</IonHeader>
			)}
			<IonContent
				fullscreen
				scrollY={scrollY}
				className={cls}
				data-testid={testId}
			>
				{!row && (
					<div slot="fixed" aria-hidden="true" className="p-sat-scrim" />
				)}
				<h1 className="p-tab-title">{title}</h1>
				{children}
			</IonContent>
			{footer}
		</>
	);
}
