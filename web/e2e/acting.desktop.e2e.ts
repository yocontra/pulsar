import type { Page } from "@playwright/test";
import {
	expect,
	localhostBase,
	proveInSheet,
	test,
	withPasskey,
} from "./fixtures.ts";

/**
 * The web side of acting ops (api.acting, src/service/acting.ts): an agent
 * here goes through Prove Human and the passkey session; one on another
 * machine through that machine's challenge for exactly this op, target and
 * params, with one passkey check and no session. The mock's stand-in op
 * (`/__mock/acting`) checks them like the daemon.
 */

type Out = { ok?: boolean; code?: string; message?: string };

/** Runs api.acting for a stand-in op; `sent` overrides the params the op's request carries. */
function act(
	page: Page,
	target: { agent?: string; machine?: string },
	params: unknown,
	sent: unknown = params,
): Promise<Out> {
	return page.evaluate(
		async ({ target, params, sent }) => {
			const h = (
				window as unknown as {
					__pulsarE2E: {
						api: {
							acting: (
								op: string,
								t: object,
								p: unknown,
								send: (a?: unknown) => Promise<unknown>,
							) => Promise<unknown>;
						};
						request: (path: string, init: object) => Promise<unknown>;
					};
				}
			).__pulsarE2E;
			try {
				return (await h.api.acting("git.commit", target, params, (assertion) =>
					h.request("/__mock/acting", {
						method: "POST",
						body: { op: "git.commit", ...target, params: sent, assertion },
					}),
				)) as Out;
			} catch (e) {
				const err = e as { code?: string; message?: string };
				return { code: err.code ?? "error", message: err.message };
			}
		},
		{ target, params, sent },
	);
}

test("acting ops: Prove Human here, the home node's challenge elsewhere", async ({
	page,
	request,
	context,
}) => {
	await page.addInitScript(() => {
		(window as { __pulsarE2E?: object }).__pulsarE2E = {};
	});
	await page.goto(`${localhostBase()}/`);
	await withPasskey(page, request, context);

	// Another machine: one passkey check over that machine's challenge.
	const remote = { agent: "m-other/pi:fixer" };
	expect(await act(page, remote, { message: "fix" })).toEqual({
		ok: true,
		op: "git.commit",
	} as Out);
	// (Params that differ from the signed ones are refused: test/acting.test.ts.)
	// A machine op elsewhere.
	expect((await act(page, { machine: "m-other" }, { cwd: "/w" })).ok).toBe(
		true,
	);

	// This machine: Prove Human once, then the session carries the op.
	const local = act(page, { agent: "pi:fixer" }, { message: "here" });
	await proveInSheet(page);
	expect((await local).ok).toBe(true);
});
