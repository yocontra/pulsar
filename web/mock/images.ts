/**
 * Sample transcript images for the mock: small PNGs generated in memory
 * (a "screenshot" of a test run and a chart), so no binary fixtures.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Uint8Array) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
	const out = new Uint8Array(12 + data.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function png(
	w: number,
	h: number,
	pixel: (x: number, y: number) => [number, number, number],
) {
	const raw = new Uint8Array((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const [r, g, b] = pixel(x, y);
			const i = y * (w * 3 + 1) + 1 + x * 3;
			raw[i] = r;
			raw[i + 1] = g;
			raw[i + 2] = b;
		}
	}
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, w);
	dv.setUint32(4, h);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const parts = [
		new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** A terminal-ish "screenshot": dark background with green and grey bars. */
export const SCREENSHOT = png(320, 180, (x, y) => {
	if (y < 18) return [58, 58, 64];
	const line = Math.floor((y - 24) / 14);
	const inText = (y - 24) % 14 < 8 && x > 12 && x < 40 + ((line * 53) % 230);
	if (inText) return line % 4 === 3 ? [120, 220, 140] : [190, 190, 196];
	return [24, 24, 28];
});

/** A bar chart. */
export const CHART = png(320, 180, (x, y) => {
	const bars = [60, 110, 85, 140, 120, 160];
	const i = Math.floor((x - 20) / 48);
	const inBar =
		x > 20 && (x - 20) % 48 < 34 && i < bars.length && 170 - y < bars[i]!;
	if (inBar) return [110, 168, 254];
	if (y === 170 || x === 20) return [140, 140, 150];
	return [250, 250, 248];
});

/** A two-page PDF with a line of text on each page (synthetic). */
export const SAMPLE_PDF = (() => {
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
		"<< /Length 58 >>\nstream\nBT /F1 24 Tf 40 220 Td (Refresh flow, page 1) Tj ET\nendstream",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
		"<< /Length 58 >>\nstream\nBT /F1 24 Tf 40 220 Td (Refresh flow, page 2) Tj ET\nendstream",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets)
		out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
})();
