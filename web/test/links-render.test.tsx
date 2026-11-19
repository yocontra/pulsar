/** Transcript links render only for http(s) and mailto (session/streamdown.tsx). */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { components, rehypePlugins } from "../src/session/streamdown.tsx";

const hrefs = (md: string) =>
	renderToStaticMarkup(
		<Streamdown
			mode="static"
			rehypePlugins={rehypePlugins}
			components={components}
			linkSafety={{ enabled: false }}
		>
			{md}
		</Streamdown>,
	).match(/href="[^"]*"/g) ?? [];

describe("transcript links", () => {
	test("http(s) and mailto stay links, in a new tab", () => {
		for (const u of [
			"https://ok.example/",
			"http://ok.example/",
			"mailto:a@b.c",
		])
			expect(hrefs(`[l](${u}) <a href="${u}">r</a>`)).toEqual([
				`href="${u}"`,
				`href="${u}"`,
			]);
	});
	test("every other scheme is text", () => {
		for (const u of [
			"irc://x/y",
			"ircs://x",
			"xmpp:a@b",
			"javascript:alert(1)",
			"blob:http://localhost/abc",
			"tel:1",
		])
			expect(hrefs(`[l](${u}) <a href="${u}">r</a>`)).toEqual([]);
	});
});
