import { useEffect, useState } from "react";
import { ProveCancelled } from "../../api/client.ts";
import type { AgentRow, LaunchHarness } from "../../api/types.ts";
import { useAgent } from "../../data/index.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import {
	launchError,
	launches,
	newNonce,
	startLaunch,
	stepText,
} from "./state.ts";

export default observer(function ResumeSession({ agent }: { agent: AgentRow }) {
	const [starting, setStarting] = useState(false);
	const [launchId, setLaunchId] = useState("");
	const [error, setError] = useState("");
	const [nonce, setNonce] = useState(newNonce);
	const launch = launches.value.get(launchId);
	const row = useAgent(agent.id);
	useEffect(() => {
		if (launch?.step === "done") void row.refetch();
	}, [launch?.step]);
	if (!can("launch") || !agent.cwd || !agent.sessionId) return null;
	const pending = starting || (!!launch && launch.step !== "failed");
	async function resume() {
		if (pending || !agent.cwd || !agent.sessionId) return;
		setStarting(true);
		setError("");
		try {
			const result = await startLaunch(agent.machineId, {
				nonce,
				cwd: agent.cwd,
				harness: agent.harness as LaunchHarness,
				workspace: "current",
				resumeSessionId: agent.sessionId,
			});
			setLaunchId(result.id);
			setNonce(newNonce());
		} catch (e) {
			if (!(e instanceof ProveCancelled))
				setError(launchError(e, agent.machineId));
		} finally {
			setStarting(false);
		}
	}
	return (
		<>
			{" "}
			<button
				type="button"
				className="btn"
				disabled={pending}
				onClick={() => void resume()}
			>
				{pending ? (launch ? stepText(launch) : "Resuming…") : "Resume session"}
			</button>
			{(error || launch?.step === "failed") && (
				<span role="alert"> {error || launch?.error}</span>
			)}
		</>
	);
});
