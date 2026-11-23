import {
	CheckIcon,
	CircleAlertIcon,
	PowerOffIcon,
	SmartphoneIcon,
	UserRoundXIcon,
	WifiOffIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FailureKind } from "../api/client.ts";
import { Kbd } from "../ds/index.ts";
import { age, plural, rollupOf } from "../lib/format.ts";
import { offlineCopy } from "../lib/reach.ts";
import { observer } from "../lib/signals.ts";
import { attention, hello, lastKnown, retry } from "../lib/store.ts";
import { NeedsRow } from "./desktop/Home.tsx";
import { Layer } from "./desktop/Layer.tsx";

const FAILURE_ICON = {
	offline: WifiOffIcon,
	"daemon-down": PowerOffIcon,
	forbidden: UserRoundXIcon,
	http: CircleAlertIcon,
} as const;

const FAILURES: Record<
	FailureKind,
	{ title: string; line: string; moreLabel: string; more?: ReactNode }
> = {
	offline: {
		// Filled in per render (lib/reach.ts): "Can't reach studio".
		title: "",
		line: "",
		moreLabel: "What to check",
		more: (
			<ul>
				<li>Open the Tailscale app and check that it's connected.</li>
				<li>Use the same Tailscale account as your machines.</li>
				<li>
					If a laptop served this page, it may be asleep. Open another node's
					address.
				</li>
			</ul>
		),
	},
	"daemon-down": {
		title: "Pulsar isn't running on that machine",
		line: "Tailscale answered, but the Pulsar daemon behind it didn't.",
		moreLabel: "How to fix it",
		more: (
			<>
				<p>On that machine, run:</p>
				<pre className="mono">pulsar doctor{"\n"}pulsar setup</pre>
				<p>Messages you send from another node wait until it's back.</p>
			</>
		),
	},
	forbidden: {
		title: "Wrong Tailscale account",
		line: "This pool belongs to a different Tailscale user.",
		moreLabel: "How to fix it",
		more: <p>Switch accounts in the Tailscale app, then retry.</p>,
	},
	http: {
		title: "Something went wrong",
		line: "The daemon returned an error. Try again in a moment.",
		moreLabel: "Error details",
	},
};

function FailureScreenImpl({
	kind,
	detail,
}: {
	kind: FailureKind;
	detail?: string;
}) {
	const f =
		kind === "offline"
			? (({ title, body }) => ({ ...FAILURES.offline, title, line: body }))(
					offlineCopy(false),
				)
			: FAILURES[kind];
	const Icon = FAILURE_ICON[kind];
	const known = lastKnown();
	const [busy, setBusy] = useState(false);
	return (
		<main className="failure d-screen is-plain" data-failure={kind}>
			<div className="st">
				<span className="st-mark" aria-hidden="true">
					<img src="/icon.svg" alt="" width={64} height={64} />
					<span className={`st-badge k-${kind}`}>
						<Icon size={14} strokeWidth={2.2} />
					</span>
				</span>
				<h1 className="st-title">{f.title}</h1>
				<p className="st-text">{f.line}</p>
				<button
					type="button"
					className="st-btn"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						await retry();
						setBusy(false);
					}}
				>
					{busy ? "Retrying…" : "Retry"}
				</button>
				{(f.more || detail) && (
					<details className="st-more">
						<summary>{f.moreLabel}</summary>
						<div className="d-screen-more">
							{f.more}
							{detail && <p className="st-code">{detail}</p>}
						</div>
					</details>
				)}
			</div>
			{known.length > 0 && (
				<section className="d-screen-known" aria-label="Last known machines">
					<h2>Last known</h2>
					<ul>
						{known.slice(0, 8).map((n) => (
							<li key={n.id}>
								<span className="d-known-name">{n.label}</span>
								<span className="d-known-sub">
									{plural(rollupOf(n).agents, "agent")} · seen{" "}
									{age(rollupOf(n).lastActive ?? 0)} ago
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</main>
	);
}

function FirstRunImpl({ onQr }: { onQr: () => void }) {
	const h = hello.value;
	return (
		<main className="first-run d-screen">
			<div className="d-screen-card wide">
				<img className="d-screen-logo" src="/icon.svg" alt="" />
				<h1>Welcome to Pulsar</h1>
				<p className="d-screen-lead">
					{h ? (
						<>
							This is <strong>{h.machine}</strong>. No agents are running yet.
						</>
					) : (
						"No agents are running yet."
					)}
				</p>
				<ol className="d-steps">
					<li>
						<span className="d-step-n" aria-hidden="true">
							1
						</span>
						<span>
							<strong>Set up each machine.</strong> Run{" "}
							<code className="d-code">npx pulsar setup</code> and turn on the
							agent mesh on every computer you want in the pool.
						</span>
					</li>
					<li>
						<span className="d-step-n" aria-hidden="true">
							2
						</span>
						<span>
							<strong>Restart your agents.</strong> Claude Code, Codex,
							OpenCode, pi and omp show up here on their own.
						</span>
					</li>
					<li>
						<span className="d-step-n" aria-hidden="true">
							3
						</span>
						<span>
							<strong>That's it.</strong> Every machine on your Tailscale
							account joins automatically. No codes, no pairing.
						</span>
					</li>
				</ol>
				<button
					type="button"
					className="d-btn primary d-screen-cta"
					onClick={onQr}
				>
					<SmartphoneIcon /> Open on phone
				</button>
			</div>
		</main>
	);
}

function NeedsListImpl(_: { mobile: boolean }) {
	const items = attention.value;
	const approvals = items.filter((i) => i.kind === "approval");
	const questions = items.filter((i) => i.kind === "asked");
	const terminal = items.filter((i) => i.kind === "terminal");
	return (
		<div className="d-scroll">
			<section className="d-page needs-list" aria-labelledby="needs-title">
				<header className="d-page-head">
					<h1 id="needs-title" className="d-title">
						Needs you
					</h1>
					<p className="d-subtitle">
						{items.length
							? `${plural(items.length, "agent")} waiting on you. Approvals first, newest first.`
							: "Nothing is waiting on you."}
					</p>
				</header>
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
					(
						[
							["Approvals", approvals],
							["Questions", questions],
							["In the terminal", terminal],
						] as const
					)
						.filter(([, g]) => g.length)
						.map(([label, g]) => (
							<section key={label} className="d-block">
								<div className="d-block-head">
									<h2>
										{label}
										<span className="d-block-count">{g.length}</span>
									</h2>
								</div>
								<ul className="d-card">
									{g.map((i) => (
										<NeedsRow key={i.id} item={i} />
									))}
								</ul>
							</section>
						))
				)}
			</section>
		</div>
	);
}

/** Shortcut groups: each entry is the key combos (alternatives) and what it does. */
const KEYS: [string, [string[][], string][]][] = [
	[
		"Anywhere",
		[
			[[["mod", "K"]], "Search or ask"],
			[[["mod", "shift", "B"]], "Broadcast"],
			[[["mod", "alt", "N"]], "New agent"],
			[[["N"]], "Next agent waiting on you"],
			[[["?"]], "Keyboard shortcuts"],
			[[["esc"]], "Close or go back"],
		],
	],
	[
		"Sidebar",
		[
			[[["/"]], "Filter"],
			[[["J"], ["K"]], "Move down, up"],
			[[["H"], ["L"]], "Collapse, expand"],
			[[["enter"]], "Open"],
			[[["X"]], "Select an agent"],
			[[["B"]], "Message the selection"],
		],
	],
	[
		"Agent",
		[
			[[["mod", "enter"]], "Send"],
			[[["mod", "."]], "Stop the current turn"],
		],
	],
];

function HelpImpl({ onClose }: { onClose: () => void }) {
	return (
		<Layer title="Keyboard shortcuts" onClose={onClose} className="d-help">
			<div className="d-pop-body d-help-body">
				{KEYS.map(([group, keys]) => (
					<section key={group} className="d-help-group">
						<h3>{group}</h3>
						<dl>
							{keys.map(([combos, d]) => (
								<div key={d} className="d-help-row">
									<dt>{d}</dt>
									<dd>
										{combos.map((c) => (
											<Kbd key={c.join("+")} keys={c} spoken />
										))}
									</dd>
								</div>
							))}
						</dl>
					</section>
				))}
			</div>
		</Layer>
	);
}

export const FailureScreen = observer(FailureScreenImpl);
export const FirstRun = observer(FirstRunImpl);
export const NeedsList = observer(NeedsListImpl);
export const Help = observer(HelpImpl);
