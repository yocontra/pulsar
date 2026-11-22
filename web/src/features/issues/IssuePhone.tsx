/**
 * The phone's issue sheet. No top-bar button (the bar is full): the agent
 * menu's "Issue #N" (`showIssue`, from the ••• button or a long-press)
 * opens it. Rendered in the agent header's slot, it shows nothing else.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import type { AgentRow } from "../../api/types.ts";
import { CloseX } from "../../components/CloseX.tsx";
import { observer } from "../../lib/signals.ts";
import { IonContent } from "../../mobile/ionic.ts";
import { useIonicLazy } from "../../mobile/lazyIonic.ts";
import { IssueCard, useAsked } from "./IssueCard.tsx";
import "./issues.css";

type Props = { agent: AgentRow; mobile: boolean; number: string };

function IssuePhone({ agent, number }: Props) {
	const lz = useIonicLazy();
	const [open, setOpen] = useState(false);
	// Mounted from the first open until it has animated out.
	const [mounted, setMounted] = useState(false);
	const show = () => {
		setMounted(true);
		setOpen(true);
	};
	useAsked(agent.id, show);
	return (
		<>
			{/* Portaled to ion-app, like the git sheet (Ionic moves it there). */}
			{lz &&
				mounted &&
				createPortal(
					<lz.IonModal
						className="i-modal"
						isOpen={open}
						aria-label={`Issue #${number}`}
						breakpoints={[0, 0.7, 1]}
						initialBreakpoint={0.7}
						handle={false}
						onIonModalDidDismiss={() => {
							setOpen(false);
							setMounted(false);
						}}
					>
						<IonContent className="p-sheet-content" scrollY={false}>
							<div className="i-sheet">
								<header className="m-sheet-head">
									<span />
									<h2>Issue #{number}</h2>
									<CloseX onClick={() => setOpen(false)} />
								</header>
								<div className="m-sheet-scroll">
									<div className="i-sheet-body">
										<IssueCard agent={agent} number={number} mobile />
									</div>
								</div>
							</div>
						</IonContent>
					</lz.IonModal>,
					document.querySelector("ion-app") ?? document.body,
				)}
		</>
	);
}

export default observer(IssuePhone);
