/**
 * The phone agent header's issue button: opens the issue card in a sheet.
 * The agent menu's "Show Issue" (`showIssue`) opens it too.
 */
import { CircleDotIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentRow } from "../../api/types.ts";
import { CloseX } from "../../components/CloseX.tsx";
import { observer } from "../../lib/signals.ts";
import { IonButton, IonContent } from "../../mobile/ionic.ts";
import { useIonicLazy } from "../../mobile/lazyIonic.ts";
import { IssueCard, useAsked } from "./IssueCard.tsx";
import "./issues.css";

type Props = { agent: AgentRow; mobile: boolean; number: string };

function IssuePhone({ agent, number }: Props) {
	const lz = useIonicLazy();
	const [open, setOpen] = useState(false);
	// Mounted from the first open until it has animated out.
	const [mounted, setMounted] = useState(false);
	const button = useRef<HTMLIonButtonElement | null>(null);
	const show = () => {
		setMounted(true);
		setOpen(true);
	};
	useAsked(agent.id, show);
	// The top bar's title keeps clear of one more button (issues.css).
	useEffect(() => {
		const title = button.current
			?.closest("ion-toolbar")
			?.querySelector("ion-title");
		title?.classList.add("i-has-issue");
		return () => title?.classList.remove("i-has-issue");
	}, []);
	return (
		<>
			<IonButton
				ref={button}
				className="i-phone-btn"
				aria-label={`Issue #${number}`}
				onClick={show}
			>
				<CircleDotIcon aria-hidden="true" />
			</IonButton>
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
