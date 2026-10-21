import { expect, test } from './fixtures';
import {
	addItemByTyping,
	createList,
	openListView,
	openShopView,
	registerAccount
} from './helpers';

// Re-adding an item from the previous-items screen. §6.10's split is a
// pure client-side view filter over `checked_at` — nothing moves in storage and
// no job runs — so fast-forwarding the browser clock past the boundary and
// reloading is enough to move a checked item from recently-checked into the
// previous-items bucket, with no server involvement. A trip ends three hours
// after its last check-off ([D-18]), so a 25-hour jump ends it whatever time
// of day the suite runs at.
test('re-add an item from the previous-items screen', async ({ page }) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);

	await addItemByTyping(page, 'Kaffee');
	await expect(page.locator('[data-testid="row"]', { hasText: 'Kaffee' })).toBeVisible();

	// Check off in shop view (§9.1: list view is planning-only).
	await openShopView(page);
	await page.locator('[data-testid="tile"]', { hasText: 'Kaffee' }).click();
	await expect(page.locator('[data-testid="done-head"]')).toBeVisible();

	// Past the next 03:00 rollover (§9.1/§6.10, [D-18]).
	await page.clock.install({ time: Date.now() });
	await page.clock.fastForward(25 * 3600 * 1000);
	await page.reload();

	// It has left the done section and the "Frühere Artikel" link
	// now carries a count (§9.1: the previous-items link lives in the shop view).
	await expect(page.locator('[data-testid="done-head"]')).toHaveCount(0);
	const prevLink = page.getByRole('button', { name: /Frühere Artikel/ });
	await expect(prevLink).toBeVisible();
	await expect(page.getByText('1 Artikel')).toBeVisible();

	await prevLink.click();
	await expect(page).toHaveURL(/\/previous$/);
	const prevRow = page.locator('[data-testid="prev-item"]').filter({ hasText: 'Kaffee' });
	await expect(prevRow).toBeVisible();

	// One tap re-adds: clears checked/checked_at, last_bought_at persists
	// (§6.10) — surfaced here as the row landing back on the active list.
	await prevRow.click();
	await expect(page.getByText('Noch keine früheren Artikel')).toBeVisible();

	// The toast's Rückgängig is the safety net for exactly this gesture: it
	// must return the article to "Frühere Artikel" — with its ORIGINAL purchase
	// date, not today's. Re-checking the row instead would stamp checked_at =
	// last_bought_at = now server-side [D-26], stranding the article in the
	// done section at the bottom of the shop view and corrupting the
	// remembered date.
	await page.getByRole('button', { name: 'Rückgängig' }).click();
	await expect(prevRow).toBeVisible();

	// Re-add once more (a fresh toast replaces the spent one) so the removal
	// flow below starts from the same on-the-list state it was written for.
	// The row is back under the same spot, and a tap there this soon after
	// the last one is the double tap the guard refuses ([D-213]); a person
	// pauses longer than a test, so the page's clock steps past the guard.
	await page.clock.runFor(1000);
	await prevRow.click();
	await expect(page.getByText('Noch keine früheren Artikel')).toBeVisible();

	await page.goBack();
	await openShopView(page);
	await expect(page.locator('[data-testid="tile"]', { hasText: 'Kaffee' })).toBeVisible();

	// …and removing it again does NOT erase the purchase. §6.10 keeps no separate
	// history record — the row IS the history — so tombstoning it must not take
	// the "we got this once" memory with it. `deleted_at` says "not on the active
	// list"; `last_bought_at` says there is still something to remember.
	await openListView(page);
	// [D-119]: planning rows carry no inline trash — removal lives in the
	// item's detail sheet. The row's name is the sheet's first door; the
	// sheet's destructive button still carries the item's accessible name.
	await page.locator('[data-testid="row"]', { hasText: 'Kaffee' }).locator('.row-name').click();
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Kaffee von der Liste entfernen' })
		.click();
	await expect(page.getByText('„Kaffee“ entfernt · bleibt unter „Frühere Artikel“')).toBeVisible();
	await expect(page.locator('[data-testid="row"]', { hasText: 'Kaffee' })).toHaveCount(0);

	// By ROLE, not text: the new toast copy contains "Frühere Artikel" too, and so
	// does SvelteKit's live-region announcer — three strict-mode matches. The
	// door is the only one of them that is a button.
	await page.getByRole('button', { name: /^Frühere Artikel/ }).click();
	await expect(page).toHaveURL(/\/previous$/);
	await expect(
		page.locator('[data-testid="prev-item"]').filter({ hasText: 'Kaffee' })
	).toBeVisible();
});
