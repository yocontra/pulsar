import { lazy, Suspense } from "react";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { approvalItem } from "../../lib/store.ts";
import { Home } from "./Home.tsx";
import { Layer } from "./Layer.tsx";

const ApprovalCard = lazy(() => import("../../approval/ApprovalCard.tsx"));

/**
 * A prompt with no conversation to show it in (approval/sessionless.ts):
 * the card as a dialog over Home. Answered or gone, it closes to Home.
 */
function PromptDialogImpl({ id }: { id: string }) {
	const item = approvalItem(id);
	const close = () => navigate({ view: "home" }, { replace: true });
	return (
		<>
			<Home />
			{item?.approval && (
				<Layer
					title={item.approval.prompt ? "Confirm" : "Approval"}
					hideTitle
					onClose={close}
					className="d-prompt-dialog"
				>
					<div className="d-prompt-dialog-scroll prompt-inline">
						<Suspense fallback={<div className="d-approval-loading" />}>
							<ApprovalCard item={item} mobile={false} inline />
						</Suspense>
					</div>
				</Layer>
			)}
		</>
	);
}

export const PromptDialog = observer(PromptDialogImpl);
