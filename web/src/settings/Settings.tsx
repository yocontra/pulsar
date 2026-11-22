import { useEffect, useRef, useState } from "react";
import { ApiError, ProveCancelled, setSessionToken } from "../api/client.ts";
import type { PasskeyInfo, UserSessionInfo } from "../api/types.ts";
import { showQr } from "../components/chrome.tsx";
import { Layer } from "../components/desktop/Layer.tsx";
import {
	usePasskeys,
	useRemovePasskey,
	useRevokeSession,
	useSessions,
} from "../data/index.ts";
import { clock, plural } from "../lib/format.ts";
import { shownSettingsSections } from "../lib/registry.tsx";
import { observer } from "../lib/signals.ts";
import { can, hello, securityVersion, showToast } from "../lib/store.ts";
import { setShowFinished, showFinished } from "../lib/subagents.ts";
import { APPEARANCES, appearance, setAppearance } from "../lib/theme.ts";
import { disablePush, enablePush, type PushState, pushState } from "./push.ts";

export const PUSH_TEXT: Record<PushState, string> = {
	unsupported: "This browser can't receive notifications.",
	"needs-install":
		"On iPhone and iPad, add Pulsar to the Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.",
	denied:
		"Notifications are blocked for this site. Allow them in the browser's settings.",
	off: "Get a notification when an agent needs your approval. It says only “Approval pending”; details stay on your machines. Turning it on asks you to prove you're human.",
	on: "On: this browser gets a notification when an agent on this machine needs your approval.",
};

/** Settings state: passkeys, notifications, confirmed browsers. */
export function useSettings() {
	const [push, setPush] = useState<PushState | null>(null);
	const [busy, setBusy] = useState(false);
	// Live reads from the data layer (they refresh on their own and on
	// `security` notices); removals are optimistic with rollback.
	const sessionsQ = useSessions();
	const keysQ = usePasskeys();
	const revokeM = useRevokeSession();
	const removeM = useRemovePasskey();
	const sessions: UserSessionInfo[] | null =
		sessionsQ.data?.sessions ?? (sessionsQ.isError ? [] : null);
	const keys: PasskeyInfo[] | null =
		keysQ.data?.items ?? (keysQ.isError ? [] : null);
	const revoke = async (s: UserSessionInfo) => {
		try {
			await revokeM.mutateAsync(s.id);
			if (s.id === hello.value?.session?.id) setSessionToken(null);
		} catch (e) {
			showToast(
				e instanceof ApiError ? e.message : "Could not sign out",
				"warn",
			);
		}
	};
	const version = securityVersion.value;
	const node = hello.value?.machine ?? "this machine";

	useEffect(() => {
		if (version) {
			void keysQ.refetch();
			void sessionsQ.refetch();
		}
	}, [version]);
	useEffect(() => {
		pushState()
			.then(setPush)
			.catch(() => setPush("unsupported"));
	}, []);

	/** The passkey whose Remove was pressed once: a second press removes it. */
	const [arming, setArming] = useState<string | null>(null);
	const remove = async (k: PasskeyInfo) => {
		if (arming !== k.id) {
			setArming(k.id);
			return;
		}
		await removeNow(k);
	};
	/** Remove without the two-press arm (the phone confirms in an action sheet). */
	const removeNow = async (k: PasskeyInfo) => {
		setArming(null);
		try {
			await removeM.mutateAsync(k.id);
		} catch (e) {
			showToast(
				e instanceof ApiError ? e.message : "Could not remove it",
				"warn",
			);
		}
	};

	/** On or off; either takes a proven device (Prove Human opens when needed). */
	const togglePush = async () => {
		setBusy(true);
		try {
			setPush(push === "on" ? await disablePush() : await enablePush());
		} catch (e) {
			showToast(
				e instanceof ProveCancelled
					? "Not proven, so notifications didn't change."
					: e instanceof ApiError
						? e.message
						: "Could not change notifications",
				"warn",
			);
			setPush(await pushState().catch(() => "unsupported" as const));
		}
		setBusy(false);
	};

	return {
		keys,
		push,
		busy,
		sessions,
		revoke,
		node,
		arming,
		remove,
		removeNow,
		togglePush,
	};
}

const SECTIONS = [
	["set-general", "General"],
	["set-appearance", "Appearance"],
	["set-push", "Notifications"],
	["set-keys", "Proven devices"],
	["set-sessions", "Signed-in browsers"],
	["set-machines", "Machines"],
] as const;

/**
 * Desktop preferences: one scrolling page with a section list on the left
 * (General, Appearance, Notifications, Proven devices, Signed-in browsers,
 * Machines).
 */
function SettingsImpl({ onClose }: { onClose: () => void }) {
	const {
		keys,
		push,
		busy,
		sessions,
		revoke,
		node,
		arming,
		remove,
		togglePush,
	} = useSettings();
	const h = hello.value;
	const [active, setActive] = useState<string>("set-general");
	// Sections features registered (lib/registry.tsx) come after ours.
	const extra = shownSettingsSections(false);
	const shown: (readonly [string, string])[] = [
		...SECTIONS.filter(
			([id]) =>
				(id !== "set-push" || can("push")) &&
				(id !== "set-keys" || can("approvals")),
		),
		...extra.map((x) => [`set-x-${x.id}`, x.title] as const),
	];
	// A clicked section stays current while its smooth scroll runs (one
	// near the bottom never reaches the top, so the spy would pick another).
	const jumping = useRef<ReturnType<typeof setTimeout> | null>(null);
	const jump = (id: string) => {
		setActive(id);
		if (jumping.current) clearTimeout(jumping.current);
		jumping.current = setTimeout(() => {
			jumping.current = null;
		}, 1000);
		document
			.getElementById(id)
			?.closest("section")
			?.scrollIntoView({ block: "start", behavior: "smooth" });
	};
	useEffect(
		() => () => {
			if (jumping.current) clearTimeout(jumping.current);
		},
		[],
	);
	const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
		if (jumping.current) return;
		const box = e.currentTarget;
		const top = box.getBoundingClientRect().top;
		let cur: string = shown[0]![0];
		for (const [id] of shown) {
			const el = document.getElementById(id);
			if (el && el.getBoundingClientRect().top - top < 80) cur = id;
		}
		// Scrolled to the bottom by hand: the last sections can't reach the
		// top, so the last one is current.
		if (
			box.scrollTop > 0 &&
			box.scrollTop + box.clientHeight >= box.scrollHeight - 2
		)
			cur = shown.at(-1)![0];
		setActive(cur);
	};
	return (
		<Layer title="Settings" hideTitle onClose={onClose} className="d-settings">
			<nav className="d-set-nav" aria-label="Settings sections">
				<p className="d-set-nav-title">Settings</p>
				{shown.map(([id, label]) => (
					<button
						key={id}
						type="button"
						className="d-nav-item"
						aria-current={active === id ? "true" : undefined}
						onClick={() => jump(id)}
					>
						{label}
					</button>
				))}
			</nav>
			<div className="d-set-main">
				<div className="d-set-scroll" onScroll={onScroll}>
					<section className="d-set-sec" aria-labelledby="set-general">
						<h3 id="set-general">General</h3>
						<ul className="d-card d-set-card">
							<li className="d-set-row">
								<span className="d-set-label">Served by</span>
								<span className="d-set-value">{h?.machine}</span>
							</li>
							{h?.you && (
								<li className="d-set-row">
									<span className="d-set-label">Operator</span>
									<span className="d-set-value">
										{h.you.name && h.you.name !== h.you.login
											? `${h.you.name} (${h.you.login})`
											: h.you.login}
									</span>
								</li>
							)}
							<li className="d-set-row">
								<span className="d-set-label">Version</span>
								<span className="d-set-value">Pulsar {h?.version}</span>
							</li>
							<li className="d-set-row">
								<span className="d-set-text">
									<span className="d-set-label">Open on phone</span>
									<span className="d-set-help">
										Scan a code with a phone on the same Tailscale account.
									</span>
								</span>
								<button
									type="button"
									className="d-btn sm"
									onClick={() => {
										onClose();
										showQr.value = true;
									}}
								>
									Show code
								</button>
							</li>
						</ul>
					</section>
					<section className="d-set-sec" aria-labelledby="set-appearance">
						<h3 id="set-appearance">Appearance</h3>
						<ul className="d-card d-set-card">
							<li className="d-set-row">
								<span className="d-set-text">
									<span className="d-set-label">Theme</span>
									<span className="d-set-help">
										System follows your computer's light or dark setting. Saved
										on this device.
									</span>
								</span>
								<div
									className="d-seg"
									role="radiogroup"
									aria-label="Appearance"
								>
									{APPEARANCES.map(([value, label]) => (
										<button
											type="button"
											key={value}
											role="radio"
											aria-checked={appearance.value === value}
											onClick={() => setAppearance(value)}
										>
											{label}
										</button>
									))}
								</div>
							</li>
							<li className="d-set-row">
								<span className="d-set-text">
									<span className="d-set-label">Show finished subagents</span>
									<span className="d-set-help">
										Off: the sidebar lists only running and idle subagents. A
										finished one stays reachable from its card in the parent's
										conversation. Saved on this device.
									</span>
								</span>
								<input
									type="checkbox"
									role="switch"
									className="d-switch"
									aria-label="Show finished subagents"
									aria-checked={showFinished.value}
									checked={showFinished.value}
									data-setting="show-finished-subagents"
									onChange={(e) => setShowFinished(e.currentTarget.checked)}
								/>
							</li>
						</ul>
					</section>
					{can("push") && (
						<section className="d-set-sec" aria-labelledby="set-push">
							<h3 id="set-push">Notifications</h3>
							<ul className="d-card d-set-card">
								<li className="d-set-row">
									<span className="d-set-text">
										<span className="d-set-label">Approval alerts</span>
										<span className="d-set-help">
											{push ? PUSH_TEXT[push] : "Checking this browser…"}
										</span>
									</span>
									<input
										type="checkbox"
										role="switch"
										className="d-switch"
										aria-label="Approval alerts"
										aria-checked={push === "on"}
										checked={push === "on"}
										disabled={busy || (push !== "on" && push !== "off")}
										onChange={togglePush}
									/>
								</li>
							</ul>
						</section>
					)}
					{can("approvals") && (
						<section className="d-set-sec" aria-labelledby="set-keys">
							<h3 id="set-keys">Proven devices</h3>
							<p className="d-set-desc">
								Each device that proved you're human on {node} has a passkey
								here (Face ID or Touch ID). To add one, open Prove Human on that
								device: a phone needs nothing else, a computer needs your
								approval from a proven device.
							</p>
							{keys === null ? (
								<ul className="d-card d-set-card" aria-busy="true">
									<li className="d-set-row">
										<span className="d-skel d-set-skel" />
									</li>
								</ul>
							) : keys.length === 0 ? (
								<p className="d-set-empty">
									No device has proven you're human on {node} yet.
								</p>
							) : (
								<ul className="d-card d-set-card">
									{keys.map((k) => (
										<li key={k.id} className="d-set-row">
											<span className="d-set-text">
												<span className="d-set-label">{k.label}</span>
												<span className="d-set-help">
													Added {new Date(k.createdAt).toLocaleDateString()}
													{k.lastUsedAt
														? ` · last used ${clock(k.lastUsedAt)}`
														: ""}
												</span>
											</span>
											<button
												type="button"
												className={`d-btn sm ${arming === k.id ? "danger-fill" : "danger"}`}
												aria-label={
													arming === k.id
														? `Confirm: remove passkey ${k.label}; that device must prove you're human again to approve`
														: `Remove passkey ${k.label}`
												}
												onClick={() => remove(k)}
											>
												{arming === k.id ? "Remove for good" : "Remove"}
											</button>
										</li>
									))}
								</ul>
							)}
						</section>
					)}
					<section className="d-set-sec" aria-labelledby="set-sessions">
						<h3 id="set-sessions">Signed-in browsers</h3>
						<p className="d-set-desc">
							Browsers that proved you're human can send as you, answer prompts,
							stop agents and remove devices: 12 hours on a computer running
							Pulsar, 7 days on a phone or tablet.
						</p>
						{sessions === null ? (
							<ul className="d-card d-set-card" aria-busy="true">
								<li className="d-set-row">
									<span className="d-skel d-set-skel" />
								</li>
							</ul>
						) : sessions.length === 0 ? (
							<p className="d-set-empty">None yet.</p>
						) : (
							<ul className="d-card d-set-card">
								{sessions.map((x) => (
									<li key={x.id} className="d-set-row">
										<span className="d-set-text">
											<span className="d-set-label">
												{x.device}
												{x.id === h?.session?.id && (
													<span className="d-set-tag">This browser</span>
												)}
											</span>
											<span className="d-set-help">
												on {x.node} · until{" "}
												{new Date(x.expiresAt).toLocaleString([], {
													dateStyle: "medium",
													timeStyle: "short",
												})}
											</span>
										</span>
										<button
											type="button"
											className="d-btn sm"
											aria-label={`Sign out ${x.device} on ${x.node}`}
											onClick={() => revoke(x)}
										>
											Sign out
										</button>
									</li>
								))}
							</ul>
						)}
					</section>
					<section className="d-set-sec" aria-labelledby="set-machines">
						<h3 id="set-machines">Machines</h3>
						<p className="d-set-desc">
							Every machine on your Tailscale account that runs Pulsar joins the
							pool on its own. No codes, no pairing.
						</p>
						<ul className="d-card d-set-card">
							<li className="d-set-row">
								<span className="d-set-label">In the pool</span>
								<span className="d-set-value">
									{h ? plural(h.machines, "machine") : "…"}
								</span>
							</li>
							<li className="d-set-row">
								<span className="d-set-label">Agents running</span>
								<span className="d-set-value">
									{h ? plural(h.agents, "agent") : "…"}
								</span>
							</li>
							<li className="d-set-row">
								<span className="d-set-text">
									<span className="d-set-label">Add a machine</span>
									<span className="d-set-help">
										On that machine, run{" "}
										<code className="d-code">npx pulsar setup</code> and turn on
										the agent mesh, then restart its agents.
									</span>
								</span>
							</li>
						</ul>
					</section>
					{extra.map((x) => {
						const Body = x.desktop!;
						return (
							<section
								key={x.id}
								className="d-set-sec"
								aria-labelledby={`set-x-${x.id}`}
							>
								<h3 id={`set-x-${x.id}`}>{x.title}</h3>
								<Body close={onClose} />
							</section>
						);
					})}
				</div>
			</div>
		</Layer>
	);
}

export default observer(SettingsImpl);
