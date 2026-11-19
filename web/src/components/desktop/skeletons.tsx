import { Skeleton } from "../../ds/index.ts";

/** The header while the agent loads: the same boxes as the real one. */
export function SessionHeaderSkeleton() {
	return (
		<header className="d-session-head session-header loading" aria-busy="true">
			<Skeleton data-shine="" className="d-sh-avatar-skel" />
			<div className="d-sh-id">
				<Skeleton
					data-shine=""
					style={{ width: 180, height: 14, marginTop: 3 }}
				/>
				<Skeleton
					data-shine=""
					style={{ width: 280, height: 11, marginTop: 9 }}
				/>
			</div>
		</header>
	);
}
