/**
 * Media in a transcript: image thumbnails that open a lightbox (zoom, pan,
 * pinch, swipe and arrow keys between the conversation's images) and PDF
 * cards that open an in-app viewer. Bytes come from the daemon's transcript
 * image endpoint as blob: URLs (they need the X-Pulsar header), and are
 * checked to be what they claim before anything shows them.
 */
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	DownloadIcon,
	ExternalLinkIcon,
	FileTextIcon,
	MinusIcon,
	PlusIcon,
} from "lucide-react";
import { Dialog } from "radix-ui";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import type { TranscriptEvent } from "../api/types.ts";
import { CloseX } from "../components/CloseX.tsx";
import { ImageUnavailable, useApiBlob, useApiImage } from "./streamdown.tsx";

type Image = NonNullable<TranscriptEvent["images"]>[number];
type Doc = NonNullable<TranscriptEvent["documents"]>[number];

// ------------------------------------------------------------------ images

/**
 * An image in the conversation: a thumbnail that opens the lightbox on
 * every image in the same conversation, starting at this one.
 */
export function ImageThumb({ image }: { image: Image }) {
	const { src, error } = useApiImage(image.url);
	const [open, setOpen] = useState<{ list: string[]; at: number } | null>(null);
	const ref = useRef<HTMLButtonElement>(null);
	if (error) return <ImageUnavailable why={error} />;
	if (!src) return <div className="image-pending ds-sk" aria-busy="true" />;
	return (
		<>
			<button
				ref={ref}
				type="button"
				className="ds-thumb"
				aria-label="Open image"
				data-src={src}
				onClick={() => {
					// Every loaded image in this conversation, in reading order.
					const conv = ref.current?.closest(".ds-conv");
					const list = conv
						? [...conv.querySelectorAll<HTMLElement>(".ds-thumb[data-src]")]
								.map((el) => el.dataset.src!)
								.filter(Boolean)
						: [src];
					setOpen({ list, at: Math.max(0, list.indexOf(src)) });
				}}
			>
				<img
					src={src}
					alt="Attachment"
					className="transcript-image"
					// Not lazy: the bytes are already in memory (a blob: URL). A lazy
					// image gets its size only as it scrolls near, which on WebKit can
					// land inside a ResizeObserver pass (the conversation's
					// stick-to-bottom) and log "ResizeObserver loop completed with
					// undelivered notifications".
				/>
			</button>
			{open && (
				<Lightbox
					images={open.list}
					start={open.at}
					onClose={() => {
						setOpen(null);
						ref.current?.focus();
					}}
				/>
			)}
		</>
	);
}

const MIN = 1;
const MAX = 6;
const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

type View = { scale: number; x: number; y: number };
const fit = (): View => ({ scale: 1, x: 0, y: 0 });
/** `s` at a new scale; back at 1 the pan resets too. */
const rescale = (s: View, scale: number): View =>
	scale === 1 ? { scale, x: 0, y: 0 } : { ...s, scale };
/** Double tap or double click: zoom in to 2.5×, or back out to fit. */
const toggleZoom = (s: View): View =>
	s.scale > 1 ? fit() : { ...s, scale: 2.5 };
/** The distance between two pointers (for pinch zoom). */
const spread = (pts: { x: number; y: number }[]) =>
	Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);

/**
 * Full-size images over the page. Desktop: ← → between images, + − 0 to
 * zoom, wheel to zoom, drag to pan, Escape to close. Phone: pinch and
 * double-tap to zoom, drag to pan, swipe sideways between images.
 */
export function Lightbox({
	images,
	start = 0,
	onClose,
}: {
	images: string[];
	start?: number;
	onClose: () => void;
}) {
	const [at, setAt] = useState(start);
	const [z, setZ] = useState(fit);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const gesture = useRef<{
		dist?: number;
		scale: number;
		x: number;
		y: number;
		px: number;
		py: number;
		moved: boolean;
	} | null>(null);
	const lastTap = useRef(0);
	const n = images.length;
	const go = useCallback(
		(d: number) => {
			if (n < 2) return;
			setAt((i) => (i + d + n) % n);
			setZ(fit());
		},
		[n],
	);
	const zoom = useCallback(
		(f: number) => setZ((s) => rescale(s, clamp(s.scale * f, MIN, MAX))),
		[],
	);

	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowRight") go(1);
		else if (e.key === "ArrowLeft") go(-1);
		else if (e.key === "+" || e.key === "=") zoom(1.5);
		else if (e.key === "-") zoom(1 / 1.5);
		else if (e.key === "0") setZ(fit());
		else return;
		e.preventDefault();
	};

	const down = (e: ReactPointerEvent) => {
		(e.target as Element).setPointerCapture?.(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const pts = [...pointers.current.values()];
		gesture.current = {
			scale: z.scale,
			x: z.x,
			y: z.y,
			px: e.clientX,
			py: e.clientY,
			moved: false,
			...(pts.length === 2 ? { dist: spread(pts) } : {}),
		};
	};
	const move = (e: ReactPointerEvent) => {
		if (!pointers.current.has(e.pointerId) || !gesture.current) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const g = gesture.current;
		const pts = [...pointers.current.values()];
		if (pts.length === 2 && g.dist) {
			const scale = clamp((g.scale * spread(pts)) / g.dist, MIN, MAX);
			g.moved = true;
			setZ((s) => rescale(s, scale));
			return;
		}
		const dx = e.clientX - g.px;
		const dy = e.clientY - g.py;
		if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
		if (g.scale > 1) setZ({ scale: g.scale, x: g.x + dx, y: g.y + dy });
	};
	const up = (e: ReactPointerEvent) => {
		const g = gesture.current;
		pointers.current.delete(e.pointerId);
		if (pointers.current.size > 0) return;
		gesture.current = null;
		if (!g) return;
		// A tap or click on the backdrop around the image closes, as in
		// every other dialog.
		if (!g.moved && !g.dist && e.target === e.currentTarget) {
			onClose();
			return;
		}
		const dx = e.clientX - g.px;
		// Not zoomed: a sideways swipe moves between images.
		if (g.scale === 1 && !g.dist && Math.abs(dx) > 60) {
			go(dx < 0 ? 1 : -1);
			return;
		}
		if (!g.moved && e.pointerType !== "mouse") {
			const now = Date.now();
			if (now - lastTap.current < 300) setZ(toggleZoom);
			lastTap.current = now;
		}
	};

	return (
		<Dialog.Root open onOpenChange={(o) => !o && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="ds-lightbox-overlay" />
				<Dialog.Content
					className="ds-lightbox"
					aria-describedby={undefined}
					onKeyDown={onKey}
				>
					<Dialog.Title className="sr-only">
						Image {at + 1} of {n}
					</Dialog.Title>
					<div
						className={`ds-lightbox-stage${z.scale > 1 ? " is-zoomed" : ""}`}
						onPointerDown={down}
						onPointerMove={move}
						onPointerUp={up}
						onPointerCancel={up}
						onDoubleClick={() => setZ(toggleZoom)}
						onWheel={(e) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
					>
						<img
							src={images[at]}
							alt={`Attachment ${at + 1} of ${n}, full size`}
							draggable={false}
							style={{
								transform: `translate(${z.x}px, ${z.y}px) scale(${z.scale})`,
							}}
						/>
					</div>
					<div className="ds-lightbox-bar">
						{n > 1 && (
							<span className="ds-lightbox-count">
								{at + 1} of {n}
							</span>
						)}
						<button
							type="button"
							className="ds-icon-btn"
							aria-label="Zoom out"
							title="Zoom out"
							disabled={z.scale <= MIN}
							onClick={() => zoom(1 / 1.5)}
						>
							<MinusIcon aria-hidden="true" />
						</button>
						<button
							type="button"
							className="ds-icon-btn"
							aria-label="Zoom in"
							title="Zoom in"
							disabled={z.scale >= MAX}
							onClick={() => zoom(1.5)}
						>
							<PlusIcon aria-hidden="true" />
						</button>
					</div>
					{n > 1 && (
						<>
							<button
								type="button"
								className="ds-icon-btn ds-lightbox-nav is-prev"
								aria-label="Previous image"
								title="Previous image"
								onClick={() => go(-1)}
							>
								<ChevronLeftIcon aria-hidden="true" />
							</button>
							<button
								type="button"
								className="ds-icon-btn ds-lightbox-nav is-next"
								aria-label="Next image"
								title="Next image"
								onClick={() => go(1)}
							>
								<ChevronRightIcon aria-hidden="true" />
							</button>
						</>
					)}
					<Dialog.Close asChild>
						<CloseX tone="media" className="ds-lightbox-close" />
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

// ------------------------------------------------------------------ PDFs

/** "1.2 MB", "868 bytes". */
export function size(bytes: number | undefined): string | null {
	if (bytes === undefined) return null;
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "PDF · 12 pages · 1.2 MB". */
export function docFacts(doc: Doc): string {
	return [
		"PDF",
		doc.pages
			? `${doc.pages.toLocaleString("en-US")} ${doc.pages === 1 ? "page" : "pages"}`
			: null,
		size(doc.bytes),
	]
		.filter(Boolean)
		.join(" · ");
}

/** A PDF in the conversation: a card that opens the in-app viewer. */
export function DocumentCard({ doc }: { doc: Doc }) {
	const [open, setOpen] = useState(false);
	const name = doc.name || "Document.pdf";
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger className="ds-doc" aria-label={`Open ${name}`}>
				<span className="ds-doc-icon" aria-hidden="true">
					<FileTextIcon />
				</span>
				<span className="ds-doc-text">
					<span className="ds-doc-name">{name}</span>
					<span className="ds-doc-facts">{docFacts(doc)}</span>
				</span>
			</Dialog.Trigger>
			{open && <PdfViewer doc={doc} name={name} />}
		</Dialog.Root>
	);
}

/** Why a PDF can't be shown, where the reason helps. */
const PDF_WHY: Partial<
	Record<NonNullable<ReturnType<typeof useApiBlob>["error"]>, string>
> = {
	"too-large": " (over 32 MB)",
	missing: ": the agent's machine no longer has it",
};

/**
 * The PDF full screen in a frame from a blob: URL (CSP `frame-src blob:`),
 * with Open in a new tab (the browser's own viewer, best on iPhone) and
 * Download. The bytes must come back as application/pdf.
 */
function PdfViewer({ doc, name }: { doc: Doc; name: string }) {
	const { src, error } = useApiBlob(doc.url, /^application\/pdf$/);
	return (
		<Dialog.Portal>
			<Dialog.Overlay className="ds-lightbox-overlay" />
			<Dialog.Content className="ds-pdf" aria-describedby={undefined}>
				<header className="ds-pdf-bar">
					<Dialog.Title className="ds-pdf-title">{name}</Dialog.Title>
					<span className="ds-pdf-facts">{docFacts(doc)}</span>
					{src && (
						<>
							<a
								className="ds-icon-btn"
								href={src}
								target="_blank"
								rel="noopener"
								aria-label="Open in a new tab"
								title="Open in a new tab"
							>
								<ExternalLinkIcon aria-hidden="true" />
							</a>
							<a
								className="ds-icon-btn"
								href={src}
								download={name}
								aria-label="Download"
								title="Download"
							>
								<DownloadIcon aria-hidden="true" />
							</a>
						</>
					)}
					<Dialog.Close asChild>
						<CloseX className="ds-pdf-x" />
					</Dialog.Close>
				</header>
				{error ? (
					<p className="ds-pdf-msg">
						This PDF can't be shown{PDF_WHY[error] ?? ""}.
					</p>
				) : src ? (
					<iframe className="ds-pdf-frame" src={src} title={name} />
				) : (
					<p className="ds-pdf-msg">Loading…</p>
				)}
			</Dialog.Content>
		</Dialog.Portal>
	);
}

/** The images and documents of an event, in order: images first. */
export function EventMedia({ ev }: { ev: TranscriptEvent }) {
	const images = ev.images ?? [];
	const docs = ev.documents ?? [];
	if (!images.length && !docs.length) return null;
	return (
		<>
			{images.length > 0 && (
				<div
					className={`transcript-images${images.length > 1 ? " is-many" : ""}`}
				>
					{images.map((im) => (
						<ImageThumb key={im.id} image={im} />
					))}
				</div>
			)}
			{docs.length > 0 && (
				<div className="ds-docs">
					{docs.map((d) => (
						<DocumentCard key={d.id} doc={d} />
					))}
				</div>
			)}
		</>
	);
}
