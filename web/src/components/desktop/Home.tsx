import {
	CheckIcon,
	ChevronRightIcon,
	MessageCircleQuestionIcon,
	ShieldIcon,
	SquareTerminalIcon,
} from "lucide-react";
import type { AgentRow, AttentionItem } from "../../api/types.ts";
import { openPrompt } from "../../approval/focus.ts";
import { terminalWhy } from "../../approval/terminal.ts";
import { useNow } from "../../data/clock.ts";
import { AgentAvatar, AgentStatus, Kbd } from "../../ds/index.ts";
import { age, fullDate, plural } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { attention, hello, recent } from "../../lib/store.ts";
import { showHelp, showPalette } from "../chrome.tsx";
import { needsLine } from "../TreeDesktop.tsx";

function greeting(d = new Date()) {
	const h = d.getHours();
	if (h < 5) return "Good evening";
	if (h < 12) return "Good morning";
	if (h < 18) return "Good afternoon";
	return "Good evening";
}

const openItem = (i: AttentionItem) =>
	i.kind === "approval"
		? void openPrompt(i.agent.id)
		: navigate({ view: "agent", id: i.agent.id });

export function NeedsRow({ item }: { item: AttentionItem }) {
	const now = useNow();
	const a = item.agent;
	const approval = item.kind === "approval";
	const terminal = item.kind === "terminal";
	const why = terminal ? terminalWhy(item) : null;
	return (
		<li>
			<button
				type="button"
				className="d-card-row attn"
				onClick={() => openItem(item)}
				aria-label={`${needsLine(item)}, ${a.name} on ${a.machine}, ${age(item.createdAt)} ago`}
			>
				<span className="d-av-wrap">
					<AgentAvatar harness={a.harness} size="list" />
					<span className="d-av-badge" aria-hidden="true">
						{approval ? (
							<ShieldIcon />
						) : terminal ? (
							<SquareTerminalIcon />
						) : (
							<MessageCircleQuestionIcon />
						)}
					</span>
				</span>
				<span className="d-card-text">
					<span className="d-card-title">{needsLine(item)}</span>
					<span className="d-card-sub">
						{a.name}
						<span className="d-dot-sep" aria-hidden="true" />
						{a.machine}
						{a.project && a.project !== a.name && (
							<>
								<span className="d-dot-sep" aria-hidden="true" />
								{a.project}
							</>
						)}
						{why && (
							<>
								<span className="d-dot-sep" aria-hidden="true" />
								{why}
							</>
						)}
					</span>
				</span>
				<span className="d-card-age" title={fullDate(item.createdAt)}>
					{age(item.createdAt, now)}
				</span>
				<span className="d-btn sm d-card-cta">
					{approval ? "Review" : terminal ? "View" : "Reply"}
				</span>
			</button>
		</li>
	);
}

function AgentCardRow({ a }: { a: AgentRow }) {
	useNow();
	return (
		<li>
			<button
				type="button"
				className="d-card-row"
				data-prefetch-agent={a.id}
				onClick={() => navigate({ view: "agent", id: a.id })}
			>
				<AgentAvatar harness={a.harness} size="list" />
				<span className="d-card-text">
					<span className="d-card-title">{a.name}</span>
					<span className="d-card-sub">
						{a.activity ?? (a.branch ? `On ${a.branch}` : "No activity yet")}
					</span>
				</span>
				<span className="d-card-meta">{a.machine}</span>
				<AgentStatus
					state={a.state}
					since={a.stateSince}
					needsReason={a.needsYou?.reason}
					lastSession={a.sessionFrom === "folder"}
					variant={a.state === "needs-you" ? "soft" : "plain"}
				/>
				<ChevronRightIcon className="d-card-chev" aria-hidden="true" />
			</button>
		</li>
	);
}

function HomeImpl() {
	const h = hello.value!;
	const items = attention.value;
	const rec = recent.value.slice(0, 6);
	return (
		<div className="d-scroll">
			<section className="d-page" aria-labelledby="home-title">
				<header className="d-page-head">
					<h1 id="home-title" className="d-title">
						{greeting()}
					</h1>
					<p className="d-subtitle">
						{plural(h.agents, "agent")} on {plural(h.machines, "machine")}
						{items.length > 0 && (
							<>
								<span className="d-dot-sep" aria-hidden="true" />
								<span className="d-needs-text">
									{items.length} waiting on you
								</span>
							</>
						)}
					</p>
				</header>

				<section className="d-block" aria-labelledby="home-needs">
					<div className="d-block-head">
						<h2 id="home-needs">Needs you</h2>
						{items.length > 4 && (
							<button
								type="button"
								className="d-link"
								onClick={() => navigate({ view: "needs" })}
							>
								View all {items.length}
							</button>
						)}
					</div>
					{items.length === 0 ? (
						<div className="d-card d-allclear" role="status">
							<span className="d-allclear-icon" aria-hidden="true">
								<CheckIcon />
							</span>
							<div>
								<p className="d-card-title">All clear</p>
								<p className="d-card-sub">
									No agent is waiting on you. Approvals and questions show up
									here.
								</p>
							</div>
						</div>
					) : (
						<ul className="d-card">
							{items.slice(0, 4).map((i) => (
								<NeedsRow key={i.id} item={i} />
							))}
						</ul>
					)}
				</section>

				{rec.length > 0 && (
					<section className="d-block" aria-labelledby="home-recent">
						<div className="d-block-head">
							<h2 id="home-recent">Recently active</h2>
						</div>
						<ul className="d-card">
							{rec.map((a) => (
								<AgentCardRow key={a.id} a={a} />
							))}
						</ul>
					</section>
				)}

				<section className="d-hints" aria-label="Keyboard shortcuts">
					<button type="button" onClick={() => (showPalette.value = true)}>
						<Kbd keys={["mod", "K"]} /> Search or ask
					</button>
					<span>
						<Kbd keys={["/"]} /> Filter
					</span>
					<span>
						<Kbd keys={["N"]} /> Next waiting
					</span>
					<button type="button" onClick={() => (showHelp.value = true)}>
						<Kbd keys={["?"]} /> All shortcuts
					</button>
				</section>
			</section>
		</div>
	);
}

export const Home = observer(HomeImpl);
