/**
 * The top bar of an agent's page and a subagent's page: PageShell's bar
 * (ui/PageShell.tsx) with a two-line title (the name, then the live
 * status) and room under the toolbar for the page's own rows (subagents,
 * the approval banner).
 *
 * - iOS: the Liquid Glass bar, the back chevron alone (the title needs the
 *   room), the actions grouped in a glass capsule.
 * - Android: Material's top app bar: the back arrow without the previous
 *   title, the actions as icon buttons.
 *
 * The conversation scrolls in SessionView's own scroller, not IonContent.
 */
import { Glass } from "konsta/react";
import { type ReactNode, type RefObject, useEffect } from "react";
import type { Route } from "../lib/router.ts";
import { BackButton } from "./BackButton.tsx";
import { IonButtons, IonHeader, IonTitle, IonToolbar } from "./ionic.ts";
import { isMaterial } from "./platform.ts";
import "./agent.css";

export function AgentBar({
	route,
	name,
	mark,
	sub,
	end,
	below,
	compactBack = true,
	className,
}: {
	route: Route;
	name: string;
	/** Before the name, in the heading (a subagent's color dot). */
	mark?: ReactNode;
	/** The second line: status, model, type. */
	sub?: ReactNode;
	/** The actions: a glass capsule on iOS, icon buttons on Android. */
	end?: ReactNode;
	/** Rows under the toolbar, inside the bar. */
	below?: ReactNode;
	/** iOS: the chevron alone (a subagent keeps its back title). */
	compactBack?: boolean;
	className?: string;
}) {
	return (
		<IonHeader
			className={`p-bar p-agent-header${className ? ` ${className}` : ""}`}
			data-testid="agent-bar"
		>
			{!isMaterial && <div aria-hidden="true" className="p-bar-bg" />}
			<IonToolbar>
				<IonButtons slot="start">
					<BackButton route={route} compact={compactBack} />
				</IonButtons>
				<IonTitle>
					<span className="p-nav-title">
						<h1>
							{mark}
							{name}
						</h1>
						{sub && <span className="p-nav-sub">{sub}</span>}
					</span>
				</IonTitle>
				{end && (
					<IonButtons slot="end">
						{isMaterial ? (
							<div className="p-agent-actions" data-testid="agent-actions">
								{end}
							</div>
						) : (
							<Glass
								highlight={false}
								className="p-bar-glass p-agent-actions"
								data-testid="agent-actions"
							>
								{end}
							</Glass>
						)}
					</IonButtons>
				)}
			</IonToolbar>
			{below}
		</IonHeader>
	);
}

/**
 * iOS: the conversation scrolls under the glass bar and the composer dock
 * (agent.css). The page's IonContent gets the bar's height
 * (`--p-agent-top`) and the dock's (`--p-dock-h`), which SessionView's
 * column, jump pill, find bar and scroll anchoring inset by. Both change:
 * the subagents row opens, the approval banner comes and goes, the queue
 * strip, attachments and a growing message resize the dock.
 */
export function useUnderGlass(content: RefObject<HTMLElement | null>) {
	useEffect(() => {
		const el = content.current;
		if (isMaterial || !el) return;
		const page = el.closest(".ion-page");
		const head = page?.querySelector<HTMLElement>("ion-header.p-agent-header");
		const body = el.querySelector<HTMLElement>(".p-agent-body");
		if (!head || !body) return;
		let dock: HTMLElement | null = null;
		let section: Element | null = null;
		const ro = new ResizeObserver(() => {
			el.style.setProperty("--p-agent-top", `${head.offsetHeight}px`);
			el.style.setProperty("--p-dock-h", `${dock?.offsetHeight ?? 0}px`);
		});
		ro.observe(head);
		// The composer mounts with the agent: watch the session's children.
		const kids = new MutationObserver(() => bind());
		const bind = () => {
			const s = body.querySelector(":scope > section.session");
			if (s !== section) {
				kids.disconnect();
				kids.observe(body, { childList: true });
				if (s) kids.observe(s, { childList: true });
				section = s;
			}
			const d = s?.querySelector<HTMLElement>(":scope > .m-composer") ?? null;
			if (d === dock) return;
			if (dock) ro.unobserve(dock);
			dock = d;
			if (dock) ro.observe(dock);
			else el.style.setProperty("--p-dock-h", "0px");
		};
		bind();
		return () => {
			ro.disconnect();
			kids.disconnect();
		};
	}, [content]);
}
