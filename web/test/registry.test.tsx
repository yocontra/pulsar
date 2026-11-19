/**
 * Extension points (src/lib/registry.tsx): slots, settings sections, Cmd-K
 * commands and providers, and page routes.
 */
import "./window-shim.ts";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRow } from "../src/api/types.ts";
import { hrefFor, parseHash } from "../src/lib/hash.ts";
import {
	matchingCommands,
	pageFor,
	pageProps,
	Registry,
	registerCommand,
	registerPage,
	registerSettingsSection,
	registerSlot,
	Slot,
	shownSettingsSections,
	slotEntries,
} from "../src/lib/registry.tsx";

describe("Registry", () => {
	test("keeps order, then registration order; unregisters; refuses duplicates", () => {
		const r = new Registry<{ id: string; order?: number }>();
		r.add({ id: "b" });
		const offC = r.add({ id: "c", order: -1 });
		r.add({ id: "a" });
		expect(r.list().map((e) => e.id)).toEqual(["c", "b", "a"]);
		expect(() => r.add({ id: "b" })).toThrow("duplicate");
		offC();
		expect(r.list().map((e) => e.id)).toEqual(["b", "a"]);
	});
});

describe("slots", () => {
	const agent = { id: "pi:s1", name: "fixer" } as AgentRow;

	test("an empty slot renders nothing at all", () => {
		expect(slotEntries("session.header")).toEqual([]);
		expect(
			renderToStaticMarkup(
				<Slot name="session.header" agent={agent} mobile={false} />,
			),
		).toBe("");
	});

	test("components render in order with the slot's props", () => {
		const offA = registerSlot("session.header", {
			id: "t-b",
			component: ({ agent, mobile }) => (
				<button type="button">
					B {agent.name} {String(mobile)}
				</button>
			),
		});
		const offB = registerSlot("session.header", {
			id: "t-a",
			order: -1,
			component: () => <span>A</span>,
		});
		try {
			expect(
				renderToStaticMarkup(
					<Slot name="session.header" agent={agent} mobile />,
				),
			).toBe('<span>A</span><button type="button">B fixer true</button>');
		} finally {
			offA();
			offB();
		}
		expect(slotEntries("session.header")).toEqual([]);
	});
});

describe("settings sections", () => {
	test("by layout, and only while `when` holds", () => {
		let on = false;
		const offs = [
			registerSettingsSection({
				id: "t-both",
				title: "Both",
				desktop: () => <p>d</p>,
				phone: () => <p>p</p>,
			}),
			registerSettingsSection({
				id: "t-desk",
				title: "Desk",
				desktop: () => <p>d</p>,
			}),
			registerSettingsSection({
				id: "t-when",
				title: "When",
				phone: () => <p>p</p>,
				when: () => on,
			}),
		];
		try {
			expect(shownSettingsSections(false).map((s) => s.id)).toEqual([
				"t-both",
				"t-desk",
			]);
			expect(shownSettingsSections(true).map((s) => s.id)).toEqual(["t-both"]);
			on = true;
			expect(shownSettingsSections(true).map((s) => s.id)).toEqual([
				"t-both",
				"t-when",
			]);
		} finally {
			for (const off of offs) off();
		}
	});
});

describe("Cmd-K commands", () => {
	test("all with no query; else every word must match the label or keywords", () => {
		const offs = [
			registerCommand({
				id: "t-usage",
				label: "Show usage",
				keywords: ["cost", "tokens"],
				run: () => {},
			}),
			registerCommand({
				id: "t-new",
				label: "New agent",
				run: () => {},
			}),
			registerCommand({
				id: "t-hidden",
				label: "Hidden usage",
				when: () => false,
				run: () => {},
			}),
		];
		try {
			const ids = (q: string) => matchingCommands(q).map((c) => c.id);
			expect(ids("")).toEqual(["t-usage", "t-new"]);
			expect(ids("usage")).toEqual(["t-usage"]);
			expect(ids("show COST")).toEqual(["t-usage"]);
			expect(ids("new cost")).toEqual([]);
		} finally {
			for (const off of offs) off();
		}
	});
});

describe("pages", () => {
	test("a registered name routes as a page; others stay home", () => {
		expect(parseHash("#/usage")).toEqual({ view: "home" });
		const Desk = () => <p>usage</p>;
		const off = registerPage({ name: "usage", desktop: Desk });
		try {
			const r = parseHash("#/usage/7%2Fd?group=model&x=1");
			expect(r).toEqual({
				view: "page",
				name: "usage",
				arg: "7/d",
				params: { group: "model", x: "1" },
			});
			expect(parseHash(hrefFor(r))).toEqual(r);
			expect(parseHash("#/usage")).toEqual({ view: "page", name: "usage" });
			expect(hrefFor({ view: "page", name: "usage" })).toBe("#/usage");
			expect(pageFor(r)?.desktop).toBe(Desk);
			if (r.view === "page")
				expect(pageProps(r)).toEqual({
					arg: "7/d",
					params: { group: "model", x: "1" },
				});
			// Built-in routes can't be taken; names are plain.
			expect(() => registerPage({ name: "settings" })).toThrow();
			expect(() => registerPage({ name: "Bad/Name" })).toThrow();
			expect(() => registerPage({ name: "usage" })).toThrow("duplicate");
		} finally {
			off();
		}
	});
});
