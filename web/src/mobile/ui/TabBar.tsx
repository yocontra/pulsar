/**
 * The phone's tab bar (tabs.ts): a floating glass capsule on iOS, a
 * Material 3 bottom navigation bar on Android (Konsta's Tabbar follows the
 * theme). It shows on a tab's root page only; pushed pages cover it. Its
 * metrics are px (mobile/ui/ui.css), as a native bar's are: they don't
 * grow with the body text.
 */
import { Icon, Tabbar, TabbarLink, ToolbarPane } from "konsta/react";
import {
	ChartColumnIcon,
	InboxIcon,
	LayoutListIcon,
	SettingsIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { hrefFor } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { attention } from "../../lib/store.ts";
import { activeTab, atTabRoot, selectTab, TABS, type TabId } from "../tabs.ts";

const ICONS: Record<TabId, typeof InboxIcon> = {
	agents: LayoutListIcon,
	needs: InboxIcon,
	usage: ChartColumnIcon,
	settings: SettingsIcon,
};

// AA in both themes: the link tint (lighter than the fill in dark), body
// text when unselected, and the needs badge's own text color.
const LINK = {
	textIos: "text-[var(--ds-text)]",
	textActiveIos: "text-[var(--ds-link)]",
};
const BADGE = {
	bg: "bg-[var(--ds-needs-badge)]",
	text: "text-[var(--ds-on-needs)]",
};

function TabBarImpl() {
	const shown = atTabRoot.value;
	const active = activeTab.value;
	const needs = attention.value.length;
	// Konsta places the active tab's highlight after mounting: no slide in.
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => setSettled(true), 100);
		return () => clearTimeout(t);
	}, []);
	// Tab roots pad their content for the bar (mobile/ui/ui.css).
	useEffect(() => {
		document.documentElement.classList.toggle("p-tabs", shown);
	}, [shown]);
	return (
		<Tabbar
			labels
			icons
			className={`p-tabbar fixed start-0 bottom-0 z-30${shown ? "" : " is-hidden"}${settled ? "" : " is-settling"}`}
			aria-hidden={!shown}
			inert={!shown}
			data-testid="tabbar"
		>
			<ToolbarPane>
				{TABS.map((t) => {
					const I = ICONS[t.id];
					const on = t.id === active;
					const badge = t.id === "needs" && needs > 0 ? needs : undefined;
					return (
						<TabbarLink
							key={t.id}
							active={on}
							colors={LINK}
							linkProps={{
								href: hrefFor(t.route),
								"aria-current": on ? "page" : undefined,
								"aria-label": badge ? `${t.label}, ${badge}` : t.label,
								"data-testid": `tab-${t.id}`,
							}}
							onClick={(e: React.MouseEvent) => {
								e.preventDefault();
								selectTab(t.id);
							}}
							icon={
								<Icon
									ios={<I className="size-[27px]" strokeWidth={1.75} />}
									material={<I className="size-[24px]" />}
									badge={badge}
									badgeColors={BADGE}
								/>
							}
							label={t.label}
						/>
					);
				})}
			</ToolbarPane>
		</Tabbar>
	);
}

export const TabBar = observer(TabBarImpl);
