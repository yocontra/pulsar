import {
	ChevronRightIcon,
	FolderIcon,
	HashIcon,
	KeyboardIcon,
	LaptopIcon,
	MegaphoneIcon,
	SearchIcon,
	SettingsIcon,
	SmartphoneIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import type { SearchResponse } from "../api/types.ts";
import { openPrompt } from "../approval/focus.ts";
import { AgentAvatar, AgentStatus, Kbd } from "../ds/index.ts";
import { plural } from "../lib/format.ts";
import {
	matchingCommands,
	type PaletteResult,
	paletteProviders,
} from "../lib/registry.tsx";
import { navigate } from "../lib/router.ts";
import { attention, recent } from "../lib/store.ts";
import { showHelp, showQr, showSettings } from "./chrome.tsx";
import { Layer } from "./desktop/Layer.tsx";
import { needsLine } from "./TreeDesktop.tsx";

type Item = {
	key: string;
	group: string;
	label: string;
	sub?: ReactNode;
	icon: ReactNode;
	trail?: ReactNode;
	go: () => void;
};

const ICO = "d-pal-ico";

/**
 * Cmd-K: search machines, projects, agents and tags on the server, or run
 * an action. Arrow keys move, Enter opens, Esc closes.
 */
export default function Palette({ onClose }: { onClose: () => void }) {
	const [q, setQ] = useState("");
	const [res, setRes] = useState<SearchResponse | null>(null);
	const [idx, setIdx] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!q.trim()) {
			setRes(null);
			return;
		}
		const ctrl = new AbortController();
		const t = setTimeout(() => {
			api
				.search(q, ctrl.signal)
				.then(setRes)
				.catch(() => {});
		}, 120);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [q]);
	// Results of the providers features registered (lib/registry.tsx).
	const [found, setFound] = useState<Record<string, PaletteResult[]>>({});
	useEffect(() => {
		const providers = paletteProviders.list();
		setFound({});
		if (!q.trim() || providers.length === 0) return;
		const ctrl = new AbortController();
		const t = setTimeout(() => {
			for (const p of providers)
				p.search(q, ctrl.signal)
					.then((r) => {
						if (!ctrl.signal.aborted) setFound((f) => ({ ...f, [p.id]: r }));
					})
					.catch(() => {});
		}, 150);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [q]);

	const done = (fn: () => void) => () => {
		onClose();
		fn();
	};
	const items: Item[] = [];
	if (!q.trim()) {
		for (const i of attention.value.slice(0, 3))
			items.push({
				key: `att-${i.id}`,
				group: "Needs you",
				label: needsLine(i),
				sub: `${i.agent.name} · ${i.agent.machine}`,
				icon: <AgentAvatar harness={i.agent.harness} size="sm" />,
				trail: (
					<AgentStatus
						state={i.agent.state}
						since={i.agent.stateSince}
						needsReason={i.agent.needsYou?.reason}
						lastSession={i.agent.sessionFrom === "folder"}
						variant={i.agent.state === "needs-you" ? "soft" : "plain"}
					/>
				),
				go: done(() =>
					i.kind === "approval"
						? void openPrompt(i.agent.id)
						: navigate({ view: "agent", id: i.agent.id }),
				),
			});
		for (const a of recent.value.slice(0, 4))
			items.push({
				key: `rec-${a.id}`,
				group: "Recent",
				label: a.name,
				sub: a.activity ?? a.machine,
				icon: <AgentAvatar harness={a.harness} size="sm" />,
				trail: (
					<AgentStatus
						state={a.state}
						since={a.stateSince}
						needsReason={a.needsYou?.reason}
						lastSession={a.sessionFrom === "folder"}
						variant={a.state === "needs-you" ? "soft" : "plain"}
					/>
				),
				go: done(() => navigate({ view: "agent", id: a.id })),
			});
		const actions: [string, ReactNode, ReactNode, () => void][] = [
			[
				"Broadcast to everyone",
				<MegaphoneIcon key="i" className={ICO} />,
				<Kbd key="k" keys={["mod", "shift", "B"]} />,
				done(() => navigate({ view: "broadcast", selector: "*" })),
			],
			[
				"Open on phone",
				<SmartphoneIcon key="i" className={ICO} />,
				null,
				done(() => (showQr.value = true)),
			],
			[
				"Settings",
				<SettingsIcon key="i" className={ICO} />,
				null,
				done(() => (showSettings.value = true)),
			],
			[
				"Keyboard shortcuts",
				<KeyboardIcon key="i" className={ICO} />,
				<Kbd key="k" keys={["?"]} />,
				done(() => (showHelp.value = true)),
			],
		];
		for (const [label, icon, trail, go] of actions)
			items.push({
				key: `act-${label}`,
				group: "Actions",
				label,
				icon,
				trail,
				go,
			});
	}
	// Commands features registered: all with no query, else those that match.
	const commandItems: Item[] = matchingCommands(q).map((c) => ({
		key: `cmd-${c.id}`,
		group: c.group ?? "Actions",
		label: c.label,
		icon: c.icon ?? <ChevronRightIcon className={ICO} />,
		trail: c.keys ? <Kbd keys={c.keys} /> : undefined,
		go: done(c.run),
	}));
	if (!q.trim()) items.push(...commandItems);
	if (q.trim() && res) {
		for (const a of res.agents)
			items.push({
				key: a.id,
				group: "Agents",
				label: a.name,
				sub: [a.machine, a.activity ?? a.branch].filter(Boolean).join(" · "),
				icon: <AgentAvatar harness={a.harness} size="sm" />,
				trail: (
					<AgentStatus
						state={a.state}
						since={a.stateSince}
						needsReason={a.needsYou?.reason}
						lastSession={a.sessionFrom === "folder"}
						variant={a.state === "needs-you" ? "soft" : "plain"}
					/>
				),
				go: done(() => navigate({ view: "agent", id: a.id })),
			});
		for (const m of res.machines)
			items.push({
				key: m.id,
				group: "Machines",
				label: m.name,
				sub: plural(m.agents, "agent"),
				icon: <LaptopIcon className={ICO} />,
				go: done(() => navigate({ view: "node", id: m.id })),
			});
		for (const p of res.projects)
			items.push({
				key: p.id,
				group: "Projects",
				label: p.name,
				sub: `${plural(p.agents, "agent")} on ${plural(p.machines, "machine")}`,
				icon: <FolderIcon className={ICO} />,
				go: done(() =>
					navigate({ view: "broadcast", selector: `project=${p.name}` }),
				),
			});
		for (const t of res.tags)
			items.push({
				key: `tag:${t.tag}`,
				group: "Tags",
				label: t.tag,
				sub: plural(t.count, "agent"),
				icon: <HashIcon className={ICO} />,
				go: done(() => navigate({ view: "broadcast", selector: t.term })),
			});
	}
	if (q.trim()) {
		items.push(...commandItems);
		for (const p of paletteProviders.list())
			for (const r of found[p.id] ?? [])
				items.push({
					key: `${p.id}:${r.key}`,
					group: p.group,
					label: r.label,
					sub: r.sub,
					icon: r.icon ?? <SearchIcon className={ICO} />,
					trail: r.trail,
					go: done(r.run),
				});
	}
	const sel = Math.min(idx, Math.max(0, items.length - 1));

	useEffect(() => {
		list.current
			?.querySelector(`[data-idx="${sel}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setIdx(Math.min(items.length - 1, sel + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setIdx(Math.max(0, sel - 1));
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			e.preventDefault();
			items[sel]?.go();
		}
	};

	let lastGroup = "";
	return (
		<Layer
			title="Search the pool"
			hideTitle
			onClose={onClose}
			placement="top"
			className="d-palette"
			initialFocus={(e) => {
				e.preventDefault();
				input.current?.focus();
			}}
		>
			<div className="d-pal-input">
				<SearchIcon className="d-pal-lead" aria-hidden="true" />
				<input
					ref={input}
					value={q}
					placeholder="Search agents, machines, projects…"
					aria-label="Search"
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => {
						setQ((e.target as HTMLInputElement).value);
						setIdx(0);
					}}
					onKeyDown={onKey}
				/>
			</div>
			<div className="d-pal-body">
				<div
					className="d-pal-list palette-list"
					ref={list}
					role="listbox"
					aria-label="Results"
				>
					{items.map((it, i) => {
						const head = it.group !== lastGroup;
						lastGroup = it.group;
						return (
							<div key={it.key} role="presentation">
								{head && <div className="d-pal-group">{it.group}</div>}
								<button
									type="button"
									role="option"
									aria-selected={i === sel}
									data-idx={i}
									className={`d-pal-row row${i === sel ? " focused" : ""}`}
									onClick={it.go}
									onMouseMove={() => i !== sel && setIdx(i)}
								>
									{it.icon}
									<span className="d-pal-text">
										<span className="d-pal-label">{it.label}</span>
										{it.sub && <span className="d-pal-sub">{it.sub}</span>}
									</span>
									{it.trail && <span className="d-pal-trail">{it.trail}</span>}
								</button>
							</div>
						);
					})}
					{res && items.length === 0 && (
						<div className="d-pal-empty">No matches for “{q}”.</div>
					)}
				</div>
			</div>
			<footer className="d-pal-foot" aria-hidden="true">
				<span>
					<Kbd keys={["up", "down"]} /> Move
				</span>
				<span>
					<Kbd keys={["enter"]} /> Open
				</span>
				<span className="d-pal-foot-end">
					<Kbd keys={["esc"]} /> Close
				</span>
			</footer>
		</Layer>
	);
}
