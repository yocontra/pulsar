/**
 * Full-screen states: can't reach the pool (offline, daemon down, wrong
 * account, error) and the first run (no agents yet).
 */
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
import { observer } from "../lib/signals.ts";
import { failure, hello, lastKnown, retry } from "../lib/store.ts";
import { IonContent, IonItem } from "./ionic.ts";
import { IonLabel, IonList } from "./ionic-lazy.tsx";
import { linkWord } from "./rows.tsx";

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
		title: "Can't Reach Your Machines",
		body: "This iPhone can't reach your machines over Tailscale.",
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
	const c = COPY[f.kind];
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
					{busy ? "Trying Again…" : "Try Again"}
				</button>
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
				<section aria-label="Last known machines">
					<h3 className="p-set-head">Last Known Machines</h3>
					<IonList inset className="p-set-list">
						{known.slice(0, 12).map((n, i, all) => (
							<IonItem
								key={n.id}
								lines={i === all.length - 1 ? "none" : "inset"}
							>
								<span
									className="p-icon is-offline"
									slot="start"
									aria-hidden="true"
								>
									<MonitorIcon />
								</span>
								<IonLabel>{n.label}</IonLabel>
								<span className="p-quiet" slot="end">
									{linkWord(n.link) ?? "Unreachable"}
								</span>
							</IonItem>
						))}
					</IonList>
				</section>
			)}
		</IonContent>
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
			<h3 className="p-set-head">Get started</h3>
			<IonList inset className="p-set-list">
				<IonItem lines="inset">
					<span className="p-step" slot="start">
						1
					</span>
					<IonLabel className="ion-text-wrap">
						On each machine, run <code>npx pulsar setup</code> and turn on the
						agent mesh.
					</IonLabel>
				</IonItem>
				<IonItem lines="inset">
					<span className="p-step" slot="start">
						2
					</span>
					<IonLabel className="ion-text-wrap">
						Restart your agents: Claude Code, Codex, OpenCode, pi or omp.
					</IonLabel>
				</IonItem>
				<IonItem lines="none">
					<span className="p-step" slot="start">
						3
					</span>
					<IonLabel className="ion-text-wrap">
						Machines on your Tailscale account join on their own. No codes, no
						pairing.
					</IonLabel>
				</IonItem>
			</IonList>
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
