/**
 * Settings, iOS style: appearance, notifications, passkeys, signed-in browsers,
 * machines and about, as inset grouped lists with footers.
 */

import {
	BellIcon,
	CheckIcon,
	FingerprintIcon,
	GlobeIcon,
	InfoIcon,
	MonitorIcon,
	WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, setSessionToken } from "../api/client.ts";
import type { PasskeyInfo, UserSessionInfo } from "../api/types.ts";
import {
	usePasskeys,
	useRemovePasskey,
	useRevokeSession,
	useSessions,
} from "../data/index.ts";
import { clock } from "../lib/format.ts";
import { shownSettingsSections } from "../lib/registry.tsx";
import { observer } from "../lib/signals.ts";
import { branches, can, hello, nodes, showToast } from "../lib/store.ts";
import { setShowFinished, showFinished } from "../lib/subagents.ts";
import { APPEARANCES, appearance, setAppearance } from "../lib/theme.ts";
import { ProvePhoneRow } from "../prove/ProveNav.tsx";
import { PUSH_TEXT, useSettings } from "../settings/Settings.tsx";
import { BackButton } from "./BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonItem,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";
import { IonLabel, IonList, IonNote } from "./ionic-lazy.tsx";
import { useIonicLazy } from "./lazyIonic.ts";
import { Bar, linkWord } from "./rows.tsx";
import { showActions } from "./ui/actions.ts";

/** A titled inset list (registered sections render IonItems inside one). */
export function Group({
	title,
	foot,
	children,
	label,
}: {
	title: string;
	foot?: ReactNode;
	children: ReactNode;
	label?: string;
}) {
	return (
		<section className="p-set-group" aria-label={label ?? title}>
			<h3 className="p-set-head">{title}</h3>
			<IonList inset className="p-set-list">
				{children}
			</IonList>
			{foot && <p className="p-set-foot">{foot}</p>}
		</section>
	);
}

function Icon({ tone, children }: { tone: string; children: ReactNode }) {
	return (
		<span className={`p-set-icon is-${tone}`} slot="start" aria-hidden="true">
			{children}
		</span>
	);
}

async function confirm(
	header: string,
	sub: string,
	action: string,
	run: () => void,
) {
	await showActions({
		header,
		subHeader: sub,
		buttons: [
			{ text: action, role: "destructive", handler: run },
			{ text: "Cancel", role: "cancel" },
		],
	});
}

function SkeletonItem() {
	return (
		<IonItem lines="none" className="p-sk-item">
			<IonLabel>
				<span className="p-set-title" data-sk="title">
					<Bar w={46} />
				</span>
				<span className="p-set-sub" data-sk="sub">
					<Bar w={64} />
				</span>
			</IonLabel>
		</IonItem>
	);
}

function SettingsPageImpl() {
	const lz = useIonicLazy();
	// Live: passkeys and sessions come from the data layer (stream + poll).
	const { push, busy, node, togglePush } = useSettings();
	const passkeys = usePasskeys();
	const sessionsQ = useSessions();
	const revokeM = useRevokeSession();
	const removeM = useRemovePasskey();
	const keys = can("approvals") ? (passkeys.data?.items ?? null) : null;
	const sessions = sessionsQ.data?.sessions ?? (sessionsQ.isError ? [] : null);
	const fail = (e: unknown, what: string) =>
		showToast(e instanceof ApiError ? e.message : what, "warn");
	const removeNow = (k: PasskeyInfo) =>
		removeM.mutateAsync(k.id).catch((e) => fail(e, "Could not remove it"));
	const revoke = (x: UserSessionInfo) =>
		revokeM
			.mutateAsync(x.id)
			.then(() => {
				if (x.id === hello.peek()?.session?.id) setSessionToken(null);
			})
			.catch((e) => fail(e, "Could not sign out"));
	const h = hello.value;
	const machines = (branches.get("")?.ids ?? [])
		.map((id) => nodes.get(id))
		.filter((n) => n?.kind === "machine")
		.slice(0, 50);
	const removeKey = (k: PasskeyInfo) =>
		void confirm(
			`Remove “${k.label}”?`,
			"That device must prove you're human again before it can approve requests.",
			"Remove Passkey",
			() => void removeNow(k),
		);
	const signOut = (x: UserSessionInfo) =>
		void confirm(
			`Sign out ${x.device}?`,
			`It needs Face ID or Touch ID again to send as you on ${x.node}.`,
			"Sign Out",
			() => void revoke(x),
		);
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "settings" }} />
					</IonButtons>
					<IonTitle>Settings</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent fullscreen className="p-settings">
				<IonHeader collapse="condense">
					<IonToolbar>
						<IonTitle size="large">Settings</IonTitle>
					</IonToolbar>
				</IonHeader>

				{/* Prove Human leads Settings: who you are on this device. */}
				<section className="p-set-group p-set-prove" aria-label="Prove Human">
					<ProvePhoneRow />
				</section>

				<section className="p-set-group" aria-label="Appearance">
					<h3 className="p-set-head">Appearance</h3>
					<IonList
						inset
						className="p-set-list"
						role="radiogroup"
						aria-label="Appearance"
					>
						{APPEARANCES.map(([value, label], i) => {
							const on = appearance.value === value;
							return (
								<IonItem
									key={value}
									button
									detail={false}
									lines={i === APPEARANCES.length - 1 ? "none" : "inset"}
									role="radio"
									aria-checked={on ? "true" : "false"}
									className="p-set-choice"
									onClick={() => setAppearance(value)}
								>
									<IonLabel>{label}</IonLabel>
									{on && (
										<CheckIcon
											slot="end"
											className="p-set-check"
											aria-hidden="true"
										/>
									)}
								</IonItem>
							);
						})}
					</IonList>
					<p className="p-set-foot">
						System follows your iPhone's light or dark setting. Saved on this
						device.
					</p>
				</section>

				<Group
					title="Subagents"
					foot="Finished subagents stay reachable from their card in the parent's conversation. Saved on this device."
				>
					<IonItem lines="none">
						<Icon tone="gray">
							<WorkflowIcon />
						</Icon>
						{lz ? (
							<lz.IonToggle
								checked={showFinished.value}
								onIonChange={(e) => setShowFinished(e.detail.checked)}
								aria-label="Show finished subagents"
								data-setting="show-finished-subagents"
							>
								Show Finished Subagents
							</lz.IonToggle>
						) : (
							<IonLabel>Show finished subagents</IonLabel>
						)}
					</IonItem>
				</Group>

				{can("push") && (
					<Group title="Notifications" foot={push ? PUSH_TEXT[push] : " "}>
						<IonItem lines="none">
							<Icon tone="red">
								<BellIcon />
							</Icon>
							{lz ? (
								<lz.IonToggle
									checked={push === "on"}
									disabled={busy || (push !== "on" && push !== "off")}
									onIonChange={() => void togglePush()}
									aria-label="Approval alerts"
								>
									Approval Alerts
								</lz.IonToggle>
							) : (
								<IonLabel>Approval alerts</IonLabel>
							)}
						</IonItem>
					</Group>
				)}

				{can("approvals") && (
					<Group
						title="Proven devices"
						foot={
							<>
								Each device that proved you're human on {node} has a passkey
								here (Face ID or Touch ID). To add one, open Prove Human on that
								device.
							</>
						}
					>
						{keys === null ? (
							<SkeletonItem />
						) : keys.length === 0 ? (
							<IonItem lines="none">
								<Icon tone="green">
									<FingerprintIcon />
								</Icon>
								<IonLabel color="medium">
									No device has proven you're human on {node} yet
								</IonLabel>
							</IonItem>
						) : (
							keys.map((k, i) => (
								<IonItem
									key={k.id}
									lines={i === keys.length - 1 ? "none" : "inset"}
								>
									<Icon tone="green">
										<FingerprintIcon />
									</Icon>
									<IonLabel>
										<span className="p-set-title">{k.label}</span>
										<span className="p-set-sub">
											Added {new Date(k.createdAt).toLocaleDateString()}
											{k.lastUsedAt ? ` · Used ${clock(k.lastUsedAt)}` : ""}
										</span>
									</IonLabel>
									<button
										type="button"
										slot="end"
										className="p-set-action is-danger"
										aria-label={`Remove passkey ${k.label}`}
										onClick={() => removeKey(k)}
									>
										Remove
									</button>
								</IonItem>
							))
						)}
					</Group>
				)}

				<Group
					title="Signed-In Browsers"
					foot="Browsers that proved you're human can send as you, answer prompts, stop agents and remove devices: for 12 hours on a computer, 7 days on a phone or tablet."
				>
					{sessions === null ? (
						<SkeletonItem />
					) : sessions.length === 0 ? (
						<IonItem lines="none">
							<Icon tone="blue">
								<GlobeIcon />
							</Icon>
							<IonLabel color="medium">None</IonLabel>
						</IonItem>
					) : (
						sessions.map((x, i) => (
							<IonItem
								key={x.id}
								lines={i === sessions.length - 1 ? "none" : "inset"}
							>
								<Icon tone="blue">
									<GlobeIcon />
								</Icon>
								<IonLabel>
									<span className="p-set-title">
										{x.device}
										{x.id === h?.session?.id ? " (This Browser)" : ""}
									</span>
									<span className="p-set-sub">
										{x.node} · Until{" "}
										{new Date(x.expiresAt).toLocaleString([], {
											dateStyle: "medium",
											timeStyle: "short",
										})}
									</span>
								</IonLabel>
								<button
									type="button"
									slot="end"
									className="p-set-action is-danger"
									aria-label={`Sign out ${x.device} on ${x.node}`}
									onClick={() => signOut(x)}
								>
									Sign Out
								</button>
							</IonItem>
						))
					)}
				</Group>

				{machines.length > 0 && (
					<Group
						title="Machines"
						foot="Every machine on your Tailscale account that runs Pulsar joins on its own."
					>
						{machines.map((n, i) => {
							const word = linkWord(n!.link);
							return (
								<IonItem
									key={n!.id}
									lines={i === machines.length - 1 ? "none" : "inset"}
								>
									<Icon tone={word ? "gray" : "blue"}>
										<MonitorIcon />
									</Icon>
									<IonLabel>{n!.label}</IonLabel>
									<IonNote slot="end">
										{n!.link === "local"
											? "This Machine"
											: (word ?? "Connected")}
									</IonNote>
								</IonItem>
							);
						})}
					</Group>
				)}

				{/* Sections features registered (lib/registry.tsx). */}
				{shownSettingsSections(true).map((x) => {
					const Body = x.phone!;
					return (
						<Group key={x.id} title={x.title}>
							<Body />
						</Group>
					);
				})}

				{h && (
					<Group title="About">
						<IonItem lines="inset">
							<Icon tone="gray">
								<InfoIcon />
							</Icon>
							<IonLabel>Served by</IonLabel>
							<IonNote slot="end">{h.machine}</IonNote>
						</IonItem>
						{h.you && (
							<IonItem lines="inset">
								<IonLabel>Signed in as</IonLabel>
								<IonNote slot="end">{h.you.login}</IonNote>
							</IonItem>
						)}
						<IonItem lines="none">
							<IonLabel>Version</IonLabel>
							<IonNote slot="end">{h.version}</IonNote>
						</IonItem>
					</Group>
				)}
			</IonContent>
		</>
	);
}

export default observer(SettingsPageImpl);
