/** Progress in place of a git action's button (desktop and phone). */
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type GitRunner, type Phase, STEP_LABEL } from "./run.ts";

/** Seconds since `since`, ticking. */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const s = Math.max(0, Math.floor((now - since) / 1000));
	return (
		<span className="g-timer">
			{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
		</span>
	);
}

/** Progress in place of the button: running, waiting for a tap, or done. */
export function Progress({
	phase,
	run,
	mobile,
}: {
	phase: Exclude<Phase, { kind: "idle" }>;
	run: GitRunner;
	mobile: boolean;
}) {
	if (phase.kind === "done")
		return (
			<div className="g-progress done" role="status">
				{phase.href ? (
					<a href={phase.href} target="_blank" rel="noopener noreferrer">
						{phase.text}
					</a>
				) : (
					phase.text
				)}
			</div>
		);
	if (phase.kind === "paused")
		return (
			<div className="g-progress paused" role="status">
				<span>
					Step {phase.index + 1} of {phase.total}
				</span>
				<button
					type="button"
					className={mobile ? "m-btn small" : "d-btn sm primary"}
					onClick={run.resume}
				>
					Confirm {run.stepName[phase.step]}
				</button>
				<button
					type="button"
					className={mobile ? "m-btn small gray" : "d-btn sm ghost"}
					onClick={run.cancel}
				>
					Stop
				</button>
			</div>
		);
	return (
		<div className="g-progress" role="status">
			<LoaderCircleIcon aria-hidden="true" className="g-spin" />
			<span>
				{STEP_LABEL[phase.step]}…
				{phase.total > 1 && (
					<span className="g-stepn">
						{" "}
						{phase.index + 1}/{phase.total}
					</span>
				)}
			</span>
			<Elapsed since={phase.since} />
		</div>
	);
}
