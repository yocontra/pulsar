/**
 * Rendered-page audits shared by the desktop and phone UI suites
 * (ui.desktop.e2e.ts, ui.ios.e2e.ts): cursors on everything clickable,
 * bars fully inside the viewport, and AA text contrast.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Every visible element that is clickable (a native control, an interactive
 * role, or a React click handler) shows the pointer cursor, or not-allowed
 * when disabled. Returns the offenders as readable strings.
 */
export async function cursorOffenders(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const ROLES =
			"button,a[href],summary,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=radio],[role=checkbox],[role=switch],[role=treeitem],[data-clickable],[cmdk-item],input[type=checkbox],input[type=radio],ion-button,ion-back-button,ion-item.ion-activatable,ion-segment-button,ion-toggle";
		// Containers whose handler only closes or swallows clicks.
		const IGNORE =
			"[role=dialog],[role=alertdialog],[role=presentation],[role=none],[role=group],[role=region],[role=log],[role=listbox],[role=menu],[role=tablist],[role=radiogroup],[role=toolbar],form,ion-backdrop,ion-content,ion-modal,ion-app,.modal-backdrop,[data-backdrop],[data-cursor-ignore]";
		const out: string[] = [];
		const seen = new Set<Element>();
		const reactClick = (el: Element) => {
			// Ionic's React wrappers always pass their own onClick: an Ionic
			// element counts as clickable when Ionic marks it activatable.
			if (el.tagName.startsWith("ION-"))
				return el.classList.contains("ion-activatable");
			for (const k of Object.keys(el)) {
				if (!k.startsWith("__reactProps$")) continue;
				const p = (el as unknown as Record<string, Record<string, unknown>>)[k];
				return !!(p && typeof p.onClick === "function");
			}
			return false;
		};
		const desc = (el: Element) => {
			const cls =
				typeof el.className === "string"
					? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
					: "";
			const label =
				el.getAttribute("aria-label") ||
				(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
			return `${el.tagName.toLowerCase()}${cls === "." ? "" : cls} "${label}"`;
		};
		const visible = (el: Element) => {
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) return false;
			if (r.bottom < 0 || r.right < 0) return false;
			if (r.top > innerHeight || r.left > innerWidth) return false;
			if (el.closest("[aria-hidden=true],[inert],.ion-page-hidden"))
				return false;
			const s = getComputedStyle(el);
			if (s.visibility === "hidden" || s.pointerEvents === "none") return false;
			// Covered by something else (a page under a modal, say).
			const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
			const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
			const hit = document.elementFromPoint(x, y);
			return !!hit && (el.contains(hit) || hit.contains(el) || hit === el);
		};
		const disabled = (el: Element) =>
			(el as HTMLButtonElement).disabled === true ||
			el.hasAttribute("disabled") ||
			el.getAttribute("aria-disabled") === "true" ||
			!!el.closest("fieldset:disabled");
		const check = (el: Element) => {
			if (seen.has(el)) return;
			seen.add(el);
			if (el.matches(IGNORE) || !visible(el)) return;
			// An Ionic host draws its control in shadow DOM: read the cursor there.
			const native = el.shadowRoot?.querySelector(
				".item-native, .button-native, .segment-button-native, [part=native]",
			);
			const cur = getComputedStyle(native ?? el).cursor;
			const want = disabled(el) ? "not-allowed" : "pointer";
			// A disabled control may also keep `default`.
			if (cur === want || (want === "not-allowed" && cur === "default")) return;
			out.push(`${desc(el)}: cursor ${cur}, want ${want}`);
		};
		for (const el of document.querySelectorAll(ROLES)) check(el);
		for (const el of document.querySelectorAll("*"))
			if (reactClick(el)) check(el);
		return out;
	});
}

export async function expectPointerCursors(page: Page, where: string) {
	expect(await cursorOffenders(page), `cursors on ${where}`).toEqual([]);
}

/**
 * A bar (tab bar, segmented control, toolbar, composer dock) sits fully
 * inside the viewport, clear of the safe areas, and none of its labels is
 * truncated or clipped by its own box.
 */
export async function expectBarInside(
	bar: Locator,
	what: string,
	insets: { top?: number; bottom?: number } = {},
) {
	await expect(bar, what).toBeVisible();
	const r = await bar.evaluate((el, ins) => {
		const box = el.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = innerHeight;
		const problems: string[] = [];
		if (box.left < -0.5 || box.right > vw + 0.5)
			problems.push(
				`horizontally outside the viewport (${box.left}..${box.right} of ${vw})`,
			);
		if (box.top < -0.5 || box.bottom > vh + 0.5)
			problems.push(
				`vertically outside the viewport (${box.top}..${box.bottom} of ${vh})`,
			);
		// Every descendant that renders text or a control stays inside the bar
		// (minus its own padding for controls) and inside the safe area.
		for (const c of el.querySelectorAll<HTMLElement>("*")) {
			const cr = c.getBoundingClientRect();
			if (cr.width < 1 || cr.height < 1) continue;
			const s = getComputedStyle(c);
			if (s.visibility === "hidden" || s.display === "none") continue;
			// Text inputs scroll their own content.
			if (c.closest("textarea,input")) continue;
			const name = `${c.tagName.toLowerCase()}.${String(c.className).split(" ")[0]}`;
			if (cr.right > box.right + 1 || cr.left < box.left - 1)
				problems.push(`${name} spills out sideways (${cr.left}..${cr.right})`);
			if (cr.right > vw + 0.5)
				problems.push(`${name} is cut off at the right edge`);
			if (cr.bottom > vh - (ins.bottom ?? 0) + 0.5 && c.children.length === 0)
				problems.push(`${name} sits under the bottom inset`);
			if (cr.top < (ins.top ?? 0) - 0.5 && c.children.length === 0)
				problems.push(`${name} sits under the top inset`);
			const text = c.childNodes.length
				? [...c.childNodes].some(
						(n) => n.nodeType === 3 && (n.textContent ?? "").trim(),
					)
				: false;
			if (text && c.scrollWidth > c.clientWidth + 1 && s.overflow !== "visible")
				problems.push(`${name} truncates "${c.textContent?.trim()}"`);
		}
		return problems;
	}, insets);
	expect(r, `${what} fits`).toEqual([]);
}

/**
 * WCAG contrast of each element's text against its painted background
 * (translucent layers composited up the ancestor chain). Colors in any CSS
 * syntax (oklch, color-mix) resolve through a canvas.
 */
export async function contrastFailures(
	page: Page,
	selector: string,
	min = 4.5,
): Promise<string[]> {
	return page.evaluate(
		({ selector, min }) => {
			const cv = document.createElement("canvas");
			cv.width = cv.height = 1;
			const cx = cv.getContext("2d", { willReadFrequently: true })!;
			const rgba = (c: string): [number, number, number, number] => {
				cx.clearRect(0, 0, 1, 1);
				cx.fillStyle = "#000";
				cx.fillStyle = c;
				cx.fillRect(0, 0, 1, 1);
				const d = cx.getImageData(0, 0, 1, 1).data;
				return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
			};
			const over = (
				top: [number, number, number, number],
				under: [number, number, number],
			): [number, number, number] => [
				top[0] * top[3] + under[0] * (1 - top[3]),
				top[1] * top[3] + under[1] * (1 - top[3]),
				top[2] * top[3] + under[2] * (1 - top[3]),
			];
			const lum = ([r, g, b]: number[]) => {
				const f = (v: number) => {
					const s = v / 255;
					return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
			};
			const bgOf = (el: Element): [number, number, number] | null => {
				const stack: [number, number, number, number][] = [];
				for (let n: Element | null = el; n; n = n.parentElement) {
					// A shadow host (an Ionic modal, say) paints in its shadow DOM.
					const inner = n.shadowRoot?.querySelector(
						"[part=content], .modal-wrapper, .popover-content",
					);
					const s = getComputedStyle(inner ?? n);
					// Images and gradients: can't tell; skip the element.
					if (
						s.backgroundImage !== "none" &&
						!/gradient/.test(s.backgroundImage)
					)
						return null;
					const c = rgba(s.backgroundColor);
					if (c[3] > 0) stack.push(c);
					if (c[3] >= 1) break;
				}
				let base: [number, number, number] = [255, 255, 255];
				const root = rgba(getComputedStyle(document.body).backgroundColor);
				if (root[3] > 0) base = [root[0], root[1], root[2]];
				for (let i = stack.length - 1; i >= 0; i--)
					base = over(stack[i]!, base);
				return base;
			};
			const out: string[] = [];
			for (const el of document.querySelectorAll(selector)) {
				const r = el.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) continue;
				// Only text this element paints itself (not its children's).
				const own = [...el.childNodes].some(
					(n) => n.nodeType === 3 && (n.textContent ?? "").trim(),
				);
				if (!own) continue;
				// Covered by a sheet or dialog: not on screen.
				const hx = Math.min(
					innerWidth - 1,
					Math.max(0, r.left + Math.min(r.width / 2, 8)),
				);
				const hy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
				const hit = document.elementFromPoint(hx, hy);
				if (r.top > innerHeight || r.bottom < 0) continue;
				if (hit && !el.contains(hit) && !hit.contains(el)) continue;
				// Separator dots are decorative (--ds-text-4 by design).
				if (/^[·•|]$/.test((el.textContent ?? "").trim())) continue;
				if (el.closest(".sr-only,svg,[data-skip-contrast]")) continue;
				const s = getComputedStyle(el);
				if (s.visibility === "hidden" || Number(s.opacity) < 0.99) continue;
				if (el.closest("[aria-hidden=true],[disabled],[aria-disabled=true]"))
					continue;
				const bg = bgOf(el);
				if (!bg) continue;
				const fg = over(rgba(s.color), bg);
				const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
				const ratio = (a! + 0.05) / (b! + 0.05);
				// Large text (24px, or 18.66px bold) needs 3:1.
				const size = Number.parseFloat(s.fontSize);
				const large =
					size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
				const need = large ? Math.min(min, 3) : min;
				if (ratio + 0.01 < need)
					out.push(
						`"${(el.textContent ?? "").trim().slice(0, 30)}" ${ratio.toFixed(2)}:1 (${s.color} on rgb(${bg.map(Math.round).join(",")}))`,
					);
			}
			return out;
		},
		{ selector, min },
	);
}

/**
 * Buttons in dialogs, sheets and popovers that don't read as buttons: a
 * text button (ghost included; icon-only ones may stay bare) must paint a
 * fill of its own that differs from the surface under it (at least
 * 1.05:1), not white on a white dialog. Returns the offenders as readable
 * strings.
 */
export async function flatButtons(
	page: Page,
	selector = ":is([role=dialog],[role=alertdialog],[role=menu],ion-modal) :is(.d-btn,.btn,.m-btn,[data-slot=button]):not([data-variant=link])",
): Promise<string[]> {
	return page.evaluate((selector) => {
		const cv = document.createElement("canvas");
		cv.width = cv.height = 1;
		const cx = cv.getContext("2d", { willReadFrequently: true })!;
		type RGBA = [number, number, number, number];
		const rgba = (c: string): RGBA => {
			cx.clearRect(0, 0, 1, 1);
			cx.fillStyle = "#000";
			cx.fillStyle = c;
			cx.fillRect(0, 0, 1, 1);
			const d = cx.getImageData(0, 0, 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
		};
		const over = (t: RGBA, u: number[]) =>
			[0, 1, 2].map((i) => t[i]! * t[3] + u[i]! * (1 - t[3]));
		const lum = (c: number[]) => {
			const f = (v: number) => {
				const x = v / 255;
				return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
		};
		/** The composited background from `from` up (shadow hosts included). */
		const painted = (from: Element | null): number[] => {
			const stack: RGBA[] = [];
			for (let n = from; n; n = n.parentElement) {
				const inner = n.shadowRoot?.querySelector(
					"[part=content], .modal-wrapper, .popover-content",
				);
				const c = rgba(getComputedStyle(inner ?? n).backgroundColor);
				if (c[3] > 0) stack.push(c);
				if (c[3] >= 1) break;
			}
			let base = [255, 255, 255];
			for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i]!, base);
			return base;
		};
		const out: string[] = [];
		for (const el of document.querySelectorAll(selector)) {
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) continue;
			if (el.closest("[aria-hidden=true],[inert]")) continue;
			if (!(el.textContent ?? "").trim()) continue; // icon-only
			const surface = painted(el.parentElement);
			const fill = painted(el);
			const [a, b] = [lum(fill), lum(surface)].sort((x, y) => y - x);
			const ratio = (a! + 0.05) / (b! + 0.05);
			if (ratio < 1.05)
				out.push(
					`"${(el.textContent ?? "").trim().slice(0, 30)}" fill ${ratio.toFixed(3)}:1 against its surface rgb(${surface.map(Math.round).join(",")})`,
				);
		}
		return out;
	}, selector);
}

/**
 * The painted background's relative luminance (0 black … 1 white) at a
 * point (default: the viewport's center), through translucent layers and
 * shadow DOM (an iOS card sheet paints the body black behind it).
 */
export async function pageLuminance(
	page: Page,
	at?: { x: number; y: number },
): Promise<number> {
	return page.evaluate((at) => {
		const cv = document.createElement("canvas");
		cv.width = cv.height = 1;
		const cx = cv.getContext("2d", { willReadFrequently: true })!;
		const rgba = (c: string) => {
			cx.clearRect(0, 0, 1, 1);
			cx.fillStyle = "#000";
			cx.fillStyle = c;
			cx.fillRect(0, 0, 1, 1);
			const d = cx.getImageData(0, 0, 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const;
		};
		const x = at?.x ?? innerWidth / 2;
		const y = at?.y ?? innerHeight / 2;
		let el: Element | null = document.elementFromPoint(x, y);
		// Descend into open shadow roots to the innermost painted element.
		while (el?.shadowRoot) {
			const inner = el.shadowRoot.elementFromPoint(x, y);
			if (!inner || inner === el) break;
			el = inner;
		}
		const layers: (readonly [number, number, number, number])[] = [];
		for (let n: Node | null = el; n; ) {
			if (n instanceof Element) {
				const c = rgba(getComputedStyle(n).backgroundColor);
				if (c[3] > 0) layers.push(c);
				if (c[3] >= 1) break;
			}
			n =
				(n as Element).assignedSlot ??
				n.parentNode ??
				((n as ShadowRoot).host || null);
			if (n instanceof ShadowRoot) n = n.host;
		}
		let base = [255, 255, 255];
		for (let i = layers.length - 1; i >= 0; i--) {
			const t = layers[i]!;
			base = base.map((u, k) => t[k]! * t[3] + u * (1 - t[3]));
		}
		const f = (v: number) => {
			const s = v / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(base[0]!) + 0.7152 * f(base[1]!) + 0.0722 * f(base[2]!);
	}, at);
}

/**
 * Waits until the app has stopped downloading code (no new script, style or
 * chunk request for 600 ms). Reload only after this: a reload that cancels
 * an in-flight lazy import logs "Importing a module script failed" in
 * WebKit. Network idle never comes here (the event stream stays open).
 */
export async function settled(page: Page) {
	let last = -1;
	let stableSince = Date.now();
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const n = await page.evaluate(
			() =>
				performance
					.getEntriesByType("resource")
					.filter((e) => !/\/api\//.test(e.name)).length,
		);
		if (n !== last) {
			last = n;
			stableSince = Date.now();
		} else if (Date.now() - stableSince >= 600) return;
		await page.waitForTimeout(100);
	}
}

/**
 * The y of an element's first text baseline: a zero-size inline-block put
 * in front of its first text sits on the baseline. Removed again after.
 */
export async function baselineY(loc: Locator): Promise<number> {
	return loc.evaluate((el) => {
		// Wrap the first text in an inline box (a flex parent would make a
		// bare probe its own item) and put the probe in front of it.
		const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) =>
				n.textContent?.trim()
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_SKIP,
		});
		const text = walk.nextNode();
		if (!text?.parentNode) throw new Error("no text");
		const wrap = document.createElement("span");
		const probe = document.createElement("span");
		probe.style.cssText =
			"display:inline-block;width:0;height:0;vertical-align:baseline";
		text.parentNode.insertBefore(wrap, text);
		wrap.append(probe, text);
		const y = probe.getBoundingClientRect().top;
		wrap.replaceWith(text);
		return y;
	});
}

/** The vertical centre of an element's box. */
export async function midY(loc: Locator): Promise<number> {
	// Laid out first: a row that just rendered may not have a box yet.
	await loc.waitFor({ state: "visible" });
	const b = await loc.boundingBox();
	if (!b) throw new Error("no box");
	return b.y + b.height / 2;
}
