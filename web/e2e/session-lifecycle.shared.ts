import type { ServerEvents } from "../src/api/types.ts";
import { agentId, expect, ready, test } from "./fixtures.ts";

export function sessionLifecycleTest() {
	test("a live conversation title and notice stay with the selected chat", async ({
		page,
		request,
	}) => {
		const [selected, other] = await Promise.all([
			agentId(request, "name=apparish-auth"),
			agentId(request, "name=codex@apparish"),
		]);
		const emit = async (data: Record<string, unknown>) => {
			const result = await request.post("/api/v1/__mock/realtime", {
				data,
				headers: { "X-Pulsar": "1" },
			});
			expect(result.ok()).toBe(true);
		};
		const notice = (data: ServerEvents["sessionNotice"]) =>
			emit({ action: "session-notice", notice: data });
		const go = (id: string) =>
			page.evaluate((id) => {
				location.hash = `#/a/${encodeURIComponent(id)}`;
			}, id);
		const subject = page.locator(".session-conversation-title:visible");
		const toasts = page.locator('.toast[role="status"], [data-sonner-toast]');
		await page.addInitScript(() => {
			const shown = new Set<string>();
			Object.assign(window, { lifecycleToastHistory: shown });
			new MutationObserver(() => {
				for (const toast of document.querySelectorAll(
					'.toast[role="status"], [data-sonner-toast]',
				))
					if (toast.textContent) shown.add(toast.textContent);
			}).observe(document, {
				childList: true,
				subtree: true,
				characterData: true,
			});
		});
		try {
			await ready(page);
			await go(selected);
			await expect(
				page.getByRole("region", { name: "Session apparish-auth" }),
			).toBeVisible();
			await emit({
				action: "session-title",
				id: selected,
				title: "Provider subject for this chat",
			});
			await expect(subject).toHaveText("Provider subject for this chat");
			await expect(
				page.getByRole("region", { name: "Session apparish-auth" }),
			).toBeVisible();

			await notice({
				agentId: other,
				title: "A different chat warning",
				severity: "warning",
			});
			await notice({
				agentId: selected,
				title: "This chat warning",
				severity: "warning",
				description: "Check provider state",
			});
			await expect(
				toasts.filter({ hasText: "This chat warning · Check provider state" }),
			).toBeVisible();
			await expect(
				toasts.filter({ hasText: "A different chat warning" }),
			).toHaveCount(0);

			await go(other);
			await expect(
				page.getByRole("region", { name: "Session codex@apparish" }),
			).toBeVisible();
			await expect(subject).toHaveCount(0);
			await notice({
				agentId: selected,
				title: "A notice from the previous chat",
				severity: "info",
			});
			await notice({
				agentId: other,
				title: "A notice for the current chat",
				severity: "info",
			});
			await expect(
				toasts.filter({ hasText: "A notice for the current chat" }),
			).toBeVisible();
			await expect(
				toasts.filter({ hasText: "A notice from the previous chat" }),
			).toHaveCount(0);

			const seen = await page.evaluate(() => [
				...(window as unknown as { lifecycleToastHistory: Set<string> })
					.lifecycleToastHistory,
			]);
			expect(seen).not.toContain("A different chat warning");
			expect(seen).not.toContain("A notice from the previous chat");

			await go(selected);
			await expect(subject).toHaveText("Provider subject for this chat");
			await emit({ action: "session-title", id: selected, title: null });
			await expect(subject).toHaveCount(0);
		} finally {
			await emit({ action: "restore" });
		}
	});
}
