import { encode } from "uqr";
import { Layer } from "../components/desktop/Layer.tsx";
import { observer } from "../lib/signals.ts";
import { hello } from "../lib/store.ts";

/** "Open on phone": the app URL as a QR code, drawn as SVG vnodes (no innerHTML). */
function QrModalImpl({ onClose }: { onClose: () => void }) {
	const url = hello.value?.appUrl ?? location.origin;
	const qr = encode(url, { ecc: "M", border: 2 });
	let d = "";
	qr.data.forEach((row, y) => {
		row.forEach((on, x) => {
			if (on) d += `M${x} ${y}h1v1h-1z`;
		});
	});
	return (
		<Layer
			title="Open on phone"
			description="Scan with the camera on a phone signed in to the same Tailscale account."
			onClose={onClose}
			className="d-qr"
		>
			<div className="d-pop-body d-qr-body">
				<div className="d-qr-frame">
					<svg
						className="qr"
						viewBox={`0 0 ${qr.size} ${qr.size}`}
						role="img"
						aria-label={`QR code for ${url}`}
						shapeRendering="crispEdges"
					>
						<rect width={qr.size} height={qr.size} fill="#fff" />
						<path d={d} fill="#000" />
					</svg>
				</div>
				<p className="d-qr-url">{url}</p>
				<p className="d-qr-note">
					Then add it to your Home Screen for a full-screen app.
				</p>
			</div>
		</Layer>
	);
}

export default observer(QrModalImpl);
