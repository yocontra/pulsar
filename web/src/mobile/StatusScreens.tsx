/**
 * Full-screen states: can't reach the pool (offline, daemon down, wrong
 * account, error) and the first run (no agents yet). They show instead of
 * the navigation stack and tab bar: an IonContent scroller with the state
 * hero (app.css .st, shared with the boot screen) and Konsta inside.
 */

import { Button } from "konsta/react";
import {
	CircleAlertIcon,
	MonitorIcon,
	PowerOffIcon,
	TerminalIcon,
	UserRoundXIcon,
	WifiOffIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FailureKind } from "../api/client.ts";
import { offlineCopy } from "../lib/reach.ts";
import { observer } from "../lib/signals.ts";
import { failure, hello, lastKnown, retry } from "../lib/store.ts";
import { IonContent } from "./ionic.ts";
import { linkWord } from "./rows.tsx";
import { GroupedList, ListItem } from "./ui/GroupedList.tsx";
import { RowIcon, ValueRow } from "./ui/rows.tsx";

const ICON = {
	offline: WifiOffIcon,
	"daemon-down": PowerOffIcon,
	forbidden: UserRoundXIcon,
	http: CircleAlertIcon,
} as const;

const COPY: Record<
	FailureKind,
	{ title: string; body: string; moreLabel?: string; more?: ReactNode }
> = {
	offline: {
		// Filled in per render (lib/reach.ts): "Can't Reach studio".
		title: "",
		body: "",
		moreLabel: "What to Check",
		more: (
			<ul>
				<li>Open Tailscale and check that it's connected.</li>
				<li>Use the same Tailscale account as your machines.</li>
				<li>
					If a laptop served this page, wake it or open another machine's
					address.
				</li>
			</ul>
		),
	},
	"daemon-down": {
		title: "Pulsar Isn't Running",
		body: "Tailscale answered, but Pulsar on that machine didn't.",
		moreLabel: "How to Fix It",
		more: (
			<>
				<p>On that machine, run:</p>
				<pre>pulsar doctor{"\n"}pulsar setup</pre>
			</>
		),
	},
	forbidden: {
		title: "Wrong Tailscale Account",
		body: "These machines belong to another Tailscale user.",
		moreLabel: "How to Fix It",
		more: <p>Switch accounts in Tailscale, then try again.</p>,
	},
	http: {
		title: "Something Went Wrong",
		body: "Pulsar returned an error. Try again in a moment.",
		moreLabel: "Error Details",
	},
};

function Failure() {
	const f = failure.value;
	const [busy, setBusy] = useState(false);
	if (!f) return null;
	const c =
		f.kind === "offline"
			? { ...COPY.offline, ...offlineCopy(true) }
			: COPY[f.kind];
	const Icon = ICON[f.kind];
	const known = lastKnown();
	const detail = f.kind === "http" ? f.detail : undefined;
	return (
		<IonContent className="p-status" data-failure={f.kind}>
			<div className="p-status-hero st" role="alert">
				<span className="st-mark" aria-hidden="true">
					<img src="/icon.svg" alt="" width={76} height={76} />
					<span className={`st-badge k-${f.kind}`}>
						<Icon />
					</span>
				</span>
				<h1 className="st-title">{c.title}</h1>
				<p className="st-text">{c.body}</p>
				<Button
					large
					rounded
					className="p-status-btn"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						await retry();
						setBusy(false);
					}}
				>
					{busy ? "Trying Again…" : "Try Again"}
				</Button>
				{(c.more || detail) && (
					<details className="st-more">
						<summary>{c.moreLabel}</summary>
						<div className="p-status-more">
							{c.more}
							{detail && <p className="st-code">{detail}</p>}
						</div>
					</details>
				)}
			</div>
			{known.length > 0 && (
				<GroupedList title="Last Known Machines">
					{known.slice(0, 12).map((n) => (
						<ValueRow
							key={n.id}
							icon={
								<RowIcon tone="gray">
									<MonitorIcon />
								</RowIcon>
							}
							title={n.label}
							after={linkWord(n.link) ?? "Unreachable"}
						/>
					))}
				</GroupedList>
			)}
		</IonContent>
	);
}

function Step({ n, children }: { n: number; children: ReactNode }) {
	return (
		<ListItem
			media={
				<span className="p-step" aria-hidden="true">
					{n}
				</span>
			}
			title={<span className="p-step-text">{children}</span>}
		/>
	);
}

function FirstRun() {
	const h = hello.value;
	return (
		<IonContent className="p-status">
			<div className="p-status-hero">
				<img className="p-status-app" src="/icon.svg" alt="" />
				<h1>Welcome to Pulsar</h1>
				<p>
					{h ? (
						<>
							Pulsar is running on <strong>{h.machine}</strong>. Your agents
							show up here as soon as they start.
						</>
					) : (
						"Your agents show up here as soon as they start."
					)}
				</p>
			</div>
			<GroupedList title="Get Started">
				<Step n={1}>
					On each machine, run <code>npx pulsar setup</code> and turn on the
					agent mesh.
				</Step>
				<Step n={2}>
					Restart your agents: Claude Code, Codex, OpenCode, pi or omp.
				</Step>
				<Step n={3}>
					Machines on your Tailscale account join on their own. No codes, no
					pairing.
				</Step>
			</GroupedList>
			<p className="p-status-foot">
				<TerminalIcon aria-hidden="true" /> Pulsar checks for new agents
				automatically.
			</p>
		</IonContent>
	);
}

function StatusScreensImpl({ kind }: { kind: "failure" | "first-run" }) {
	return kind === "failure" ? <Failure /> : <FirstRun />;
}

export default observer(StatusScreensImpl);
