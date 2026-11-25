/**
 * The Settings tab: Prove Human, appearance, subagents, notifications,
 * proven devices, signed-in browsers, machines, the sections features
 * registered (agent activity, usage limits, diagnostics) and about, as
 * inset grouped lists (Konsta, mobile/ui/GroupedList.tsx and rows.tsx).
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
import { setShowInactive, showInactive } from "../lib/subagents.ts";
import { APPEARANCES, appearance, setAppearance } from "../lib/theme.ts";
import { ProvePhoneRow } from "../prove/ProvePhoneRow.tsx";
import { PUSH_TEXT, useSettings } from "../settings/Settings.tsx";
import { isMaterial } from "./platform.ts";
import { Bar, linkWord } from "./rows.tsx";
import { showActions } from "./ui/actions.ts";
import { GroupedList, ListItem } from "./ui/GroupedList.tsx";
import { TabShell } from "./ui/PageShell.tsx";
import { LinkRow, RowIcon, ToggleRow, ValueRow } from "./ui/rows.tsx";

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
		<ListItem
			className="p-sk-item"
			title={<Bar w={46} />}
			text={<Bar w={64} />}
		/>
	);
}

function SettingsPageImpl() {
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
		<TabShell title="Settings" className="p-settings" testId="settings">
			{/* Prove Human leads Settings: who you are on this device. */}
			<GroupedList label="Prove Human">
				<ProvePhoneRow />
			</GroupedList>

			<GroupedList
				title="Appearance"
				role="radiogroup"
				footer={`System follows your ${isMaterial ? "phone" : "iPhone"}'s light or dark setting. Saved on this device.`}
			>
				{APPEARANCES.map(([value, label]) => {
					const on = appearance.value === value;
					return (
						<LinkRow
							key={value}
							title={label}
							role="radio"
							checked={on}
							chevron={false}
							after={
								on ? (
									<CheckIcon className="p-set-check" aria-hidden="true" />
								) : undefined
							}
							onClick={() => setAppearance(value)}
						/>
					);
				})}
			</GroupedList>

			<GroupedList
				title="Subagents"
				footer="Lists normally show running subagents. Turn this on to include idle subagents and those that finished in the last day."
			>
				<ToggleRow
					icon={
						<RowIcon tone="gray">
							<WorkflowIcon />
						</RowIcon>
					}
					title="Show Idle and Finished Subagents"
					checked={showInactive.value}
					onChange={setShowInactive}
					setting="show-finished-subagents"
				/>
			</GroupedList>

			{can("push") && (
				<GroupedList
					title="Notifications"
					footer={push ? PUSH_TEXT[push] : undefined}
				>
					<ToggleRow
						icon={
							<RowIcon tone="red">
								<BellIcon />
							</RowIcon>
						}
						title="Approval Alerts"
						checked={push === "on"}
						disabled={busy || (push !== "on" && push !== "off")}
						onChange={() => void togglePush()}
						setting="approval-alerts"
					/>
				</GroupedList>
			)}

			{can("approvals") && (
				<GroupedList
					title="Proven Devices"
					footer={
						<>
							Each device that proved you're human on {node} has a passkey here
							(Face ID or Touch ID). To add one, open Prove Human on that
							device.
						</>
					}
				>
					{keys === null ? (
						<SkeletonItem />
					) : keys.length === 0 ? (
						<ValueRow
							icon={
								<RowIcon tone="green">
									<FingerprintIcon />
								</RowIcon>
							}
							title={
								<span className="p-li-muted">
									No device has proven you're human on {node} yet
								</span>
							}
						/>
					) : (
						keys.map((k) => (
							<ValueRow
								key={k.id}
								icon={
									<RowIcon tone="green">
										<FingerprintIcon />
									</RowIcon>
								}
								title={k.label}
								sub={
									<>
										Added {new Date(k.createdAt).toLocaleDateString()}
										{k.lastUsedAt ? ` · Used ${clock(k.lastUsedAt)}` : ""}
									</>
								}
								after={
									<button
										type="button"
										className="p-set-action is-danger"
										aria-label={`Remove passkey ${k.label}`}
										onClick={() => removeKey(k)}
									>
										Remove
									</button>
								}
							/>
						))
					)}
				</GroupedList>
			)}

			<GroupedList
				title="Signed-In Browsers"
				footer="Browsers that proved you're human can send as you, answer prompts, stop agents and remove devices: for 12 hours on a computer, 7 days on a phone or tablet."
			>
				{sessions === null ? (
					<SkeletonItem />
				) : sessions.length === 0 ? (
					<ValueRow
						icon={
							<RowIcon tone="blue">
								<GlobeIcon />
							</RowIcon>
						}
						title={<span className="p-li-muted">None</span>}
					/>
				) : (
					sessions.map((x) => (
						<ValueRow
							key={x.id}
							icon={
								<RowIcon tone="blue">
									<GlobeIcon />
								</RowIcon>
							}
							title={`${x.device}${x.id === h?.session?.id ? " (This Browser)" : ""}`}
							sub={`${x.node} · Until ${new Date(x.expiresAt).toLocaleString(
								[],
								{
									dateStyle: "medium",
									timeStyle: "short",
								},
							)}`}
							after={
								<button
									type="button"
									className="p-set-action is-danger"
									aria-label={`Sign out ${x.device} on ${x.node}`}
									onClick={() => signOut(x)}
								>
									Sign Out
								</button>
							}
						/>
					))
				)}
			</GroupedList>

			{machines.length > 0 && (
				<GroupedList
					title="Machines"
					footer="Every machine on your Tailscale account that runs Pulsar joins on its own."
				>
					{machines.map((n) => {
						const word = linkWord(n!.link);
						return (
							<ValueRow
								key={n!.id}
								icon={
									<RowIcon tone={word ? "gray" : "blue"}>
										<MonitorIcon />
									</RowIcon>
								}
								title={n!.label}
								after={
									n!.link === "local" ? "This Machine" : (word ?? "Connected")
								}
							/>
						);
					})}
				</GroupedList>
			)}

			{/* Sections features registered (lib/registry.tsx): Konsta rows. */}
			{shownSettingsSections(true).map((x) => {
				const Body = x.phone!;
				return (
					<GroupedList key={x.id} title={x.title}>
						<Body />
					</GroupedList>
				);
			})}

			{h && (
				<GroupedList title="About">
					<ValueRow
						icon={
							<RowIcon tone="gray">
								<InfoIcon />
							</RowIcon>
						}
						title="Served by"
						after={h.machine}
					/>
					{h.you && <ValueRow title="Signed in as" after={h.you.login} />}
					<ValueRow title="Version" after={h.version} />
				</GroupedList>
			)}
		</TabShell>
	);
}

export default observer(SettingsPageImpl);
