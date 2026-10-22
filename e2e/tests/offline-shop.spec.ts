import { expect, test } from './fixtures';
import {
	addItemByTyping,
	createList,
	expectSynced,
	itemRow,
	openListView,
	openShopView,
	registerAccount,
	shareListWith
} from './helpers';

// A full offline shop: go offline, add via typeahead, check items, reconnect,
// and the second client converges. The whole point of §8 is that
// this works without any special-case client logic — the outbox queues while
// offline, and the ordinary drain → digest-probe → SSE loop (§8.5) catches the
// second client up once the first one reconnects.
test('offline shop: add + check while offline, reconnect, second client converges', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Wochenshop');
	await openListView(pageA);

	// Share the list with a second client before going offline (invite/join are
	// online-only, §7.5/§7.6).
	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	await openListView(pageB);

	// --- A goes offline and works the list entirely locally ---
	await ctxA.setOffline(true);
	await expect(pageA.getByTestId('sync-line')).toContainText('Offline');

	await addItemByTyping(pageA, 'Milch');
	await addItemByTyping(pageA, 'Brot');
	await expect(itemRow(pageA, 'Milch')).toBeVisible();
	await expect(itemRow(pageA, 'Brot')).toBeVisible();

	// The typeahead's dedup jump also works fully offline (§9.1) — selecting the
	// row that names the existing item focuses it rather than duplicating it.
	// (Enter takes the top suggestion, which for a list holding 'Milch' is
	// the more popular 'Milchpulver' — so the exact-match dedup is exercised by
	// clicking the matching row, not Enter.)
	await pageA.getByRole('combobox', { name: 'Artikel hinzufügen' }).fill('Milch');
	await pageA.locator('[data-ta-name="Milch"]').click();
	// The box empties once the pick is stored; the one row held before it too.
	await expect(pageA.getByRole('combobox', { name: 'Artikel hinzufügen' })).toHaveValue('');
	await expect(pageA.locator('[data-testid="row"]', { hasText: 'Milch' })).toHaveCount(1);

	// Check off via the shop view (§9.1: list view is planning-only; checking
	// off happens exclusively in shop view).
	await openShopView(pageA);
	await pageA.locator('[data-testid="tile"]', { hasText: 'Milch' }).click();
	await expect(pageA.locator('[data-testid="done-head"]')).toBeVisible();
	await expect(pageA.locator('[data-testid="tile"]', { hasText: 'Brot' })).toBeVisible();

	// The chip reflects the queued, unsynced state the whole time offline.
	await expect(pageA.getByText(/nicht synchronisiert/)).toBeVisible();

	// --- reconnect: the outbox drains and the chip settles ---
	await ctxA.setOffline(false);
	await expectSynced(pageA);

	// --- second client converges ---
	// B was on the route the whole time; SSE (§8.5's freshness layer) should
	// deliver A's pushed ops live. Reload as a deterministic fallback in case
	// the SSE connection dropped during A's offline window — either path is
	// meant to converge, and the repair snapshot (§8.5) is exactly the backstop
	// for a missed event.
	await pageB.reload();
	await openShopView(pageB);
	await expect(pageB.locator('[data-testid="tile"]', { hasText: 'Brot' })).toBeVisible({
		timeout: 15_000
	});
	await expect(pageB.locator('[data-testid="done-head"]')).toBeVisible();
	await expect(pageB.locator('[data-testid="done-row"]', { hasText: 'Milch' })).toHaveCount(1);

	await ctxA.close();
	await ctxB.close();
});
