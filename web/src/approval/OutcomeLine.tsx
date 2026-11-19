import { CircleCheckIcon, CircleSlashIcon } from "lucide-react";

/** An answered prompt in the conversation: one line where its card was. */
export function OutcomeLine({ outcome }: { outcome: string }) {
	const no =
		/^(Denied|Declined|Keep|Expired|Already answered: (Denied|Declined))/i.test(
			outcome,
		);
	return (
		<p
			className={`prompt-outcome${no ? " no" : ""}`}
			role="status"
			id="approval"
		>
			{no ? (
				<CircleSlashIcon aria-hidden="true" />
			) : (
				<CircleCheckIcon aria-hidden="true" />
			)}
			<span>{outcome}</span>
		</p>
	);
}
