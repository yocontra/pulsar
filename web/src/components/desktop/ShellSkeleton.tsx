import {
	HouseIcon,
	MegaphoneIcon,
	SearchIcon,
	ShieldAlertIcon,
} from "lucide-react";
import { Kbd, Skeleton } from "../../ds/index.ts";
import { slotEntries } from "../../lib/registry.tsx";
import { D_H, TOP_SKELETON_ROWS } from "../Tree.tsx";

const WIDTHS = [0.42, 0.3, 0.5, 0.36, 0.46, 0.28, 0.4, 0.34];

/**
 * The desktop shell before the pool answers (or while the layout chunk
 * loads): the real sidebar chrome with placeholder rows, and a placeholder
 * home page. Every box matches the loaded layout (desktop.skeleton.e2e.ts
 * checks it to 1 px).
 */
export function ShellSkeleton() {
	return (
		<div className="d-app" aria-busy="true">
			<span className="sr-only" role="status">
				Loading Pulsar…
			</span>
			<aside className="d-side" aria-hidden="true">
				<header className="d-brand">
					<img src="/icon.svg" alt="" width={22} height={22} />
					<div className="d-brand-text">
						<span className="d-brand-name">Pulsar</span>
						<span className="d-brand-sub">
							<Skeleton
								data-shine=""
								className="d-skel-inline"
								style={{ width: 56 }}
							/>
						</span>
					</div>
					{/* Features' header buttons (lib/registry.tsx), then the QR button. */}
					{slotEntries("sidebar.header")
						.filter((e) => e.only !== "phone")
						.map((e) => (
							<span key={e.id} className="d-btn ghost sm icon d-skel-slot" />
						))}
					<span className="d-btn ghost sm icon d-skel-slot" />
				</header>
				<nav className="d-nav">
					<span className="d-nav-item">
						<HouseIcon /> Home
					</span>
					<span className="d-nav-item">
						<SearchIcon /> Search <Kbd keys={["mod", "K"]} />
					</span>
					<span className="d-nav-item">
						<MegaphoneIcon /> Broadcast <Kbd keys={["mod", "shift", "B"]} />
					</span>
				</nav>
				<div className="d-filter-wrap">
					<span className="d-filter">
						<SearchIcon aria-hidden="true" />
						<span className="d-input d-input-skel">
							Filter machines, projects, agents
						</span>
						<Kbd className="d-filter-kbd" keys={["/"]} />
					</span>
				</div>
				<div className="tree tree-desktop">
					<div className="tree-inner">
						<div className="vrow" style={{ height: D_H.sectionFirst }}>
							<div className="d-section">
								<Skeleton
									data-shine=""
									style={{ width: 132, height: 22, borderRadius: 7 }}
								/>
							</div>
						</div>
						{Array.from({ length: TOP_SKELETON_ROWS }, (_, i) => (
							<div
								key={i}
								className="vrow"
								style={{
									height: D_H.node,
									transform: `translateY(${D_H.sectionFirst + i * D_H.node}px)`,
								}}
							>
								<div className="d-row d-skel-row" style={{ paddingLeft: 4 }}>
									<span className="chev-space" />
									<Skeleton data-shine="" className="d-skel-ico" />
									<Skeleton
										style={{
											height: 10,
											width: `${Math.round(WIDTHS[i % WIDTHS.length]! * 100)}%`,
										}}
									/>
								</div>
							</div>
						))}
					</div>
				</div>
				<footer className="d-side-foot">
					<span className="d-conn">
						<span className="d-conn-dot" />
						Connecting…
					</span>
					<span className="spacer" />
					<span className="d-btn ghost sm prove-nav">
						<ShieldAlertIcon />
						Prove Human
					</span>
					<span className="d-btn ghost sm icon d-skel-slot" />
				</footer>
			</aside>
			<main className="d-main" aria-hidden="true">
				<div className="d-scroll">
					<section className="d-page">
						<header className="d-page-head">
							<div className="d-skel-line" style={{ height: 32 }}>
								<Skeleton data-shine="" style={{ width: 220, height: 24 }} />
							</div>
							<div className="d-skel-line" style={{ height: 20, marginTop: 6 }}>
								<Skeleton data-shine="" style={{ width: 300, height: 12 }} />
							</div>
						</header>
						<div className="d-block">
							<div className="d-block-head">
								<div className="d-skel-line" style={{ height: 18 }}>
									<Skeleton data-shine="" style={{ width: 72, height: 10 }} />
								</div>
							</div>
							<ul className="d-card">
								{[0, 1, 2, 3].map((i) => (
									<li key={i}>
										<div className="d-card-row">
											<Skeleton data-shine="" className="d-card-av-skel" />
											<span className="d-card-text">
												<Skeleton
													style={{
														width: `${40 + i * 7}%`,
														height: 11,
														margin: "3px 0",
													}}
												/>
												<Skeleton
													style={{
														width: `${28 + i * 5}%`,
														height: 9,
														margin: "5px 0 2px",
													}}
												/>
											</span>
										</div>
									</li>
								))}
							</ul>
						</div>
					</section>
				</div>
			</main>
		</div>
	);
}
