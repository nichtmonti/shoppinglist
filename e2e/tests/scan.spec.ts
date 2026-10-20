import { expect, test, type Page } from './fixtures';
import {
	createList,
	disableConditionalMediation,
	FAKE_IMAGE_URL,
	injectFakeBarcode,
	openListView,
	openShopView,
	registerAccount,
	shareListWith,
	stubBarcodeLookup
} from './helpers';

// A barcode scan (stubbed lookup) creates an item carrying barcode +
// image_url, and the second client renders it as a picture (§9.2), keeps it
// offline in the service worker's photo cache, and drops that cache when it
// signs out (§5.6).
//
// Two things are stubbed, both explicitly out of scope for what this criterion
// tests: the camera + WASM decode step (the `window.__e2eFakeBarcode` hook in
// lib/scan/decode.ts, an E2E-only injection point that skips straight past the
// camera to §9.2 step 2 — the decode itself is scan-decode.spec.ts's) and the backend barcode proxy (via page.route, so the
// suite never depends on a real Open Food Facts call). Every other part of the
// pipeline — resolve, scan-dedup, create, sync, and the second client's
// rendering — runs for real.

test('barcode scan creates an item with barcode + image_url; a second client renders the picture', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	await stubBarcodeLookup(ctxA);
	const pageA = await ctxA.newPage();
	await injectFakeBarcode(pageA);
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Wochenshop');
	await openListView(pageA);

	const ctxB = await browser.newContext();
	await stubBarcodeLookup(ctxB); // harmless on B — it never triggers a lookup, only renders the synced image_url
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	await openListView(pageB);

	// §9.2 pipeline: tap 📷 → the fake decode resolves instantly → cache miss →
	// stubbed proxy lookup → item created carrying barcode + image_url.
	await pageA.locator('[data-testid="scan-trigger"]').click();
	const rowA = pageA.locator('[data-testid="row"]', { hasText: 'Testprodukt Sonnencreme' });
	await expect(rowA).toBeVisible({ timeout: 10_000 });

	// Scan-dedup (§9.1/§9.2): scanning the SAME barcode again must not create a
	// second row. The completion event: the dedup resolves to the existing row,
	// scrolls it into view and says so in a toast (applyDedupHit; the row no
	// longer takes focus, so typing in the add box goes on). The dedup path
	// creates nothing, so the count is stable once the toast showed.
	await pageA.locator('[data-testid="scan-trigger"]').click();
	await expect(pageA.getByText('„Testprodukt Sonnencreme“ ist schon auf der Liste')).toBeVisible();
	await expect(
		pageA.locator('[data-testid="row"]', { hasText: 'Testprodukt Sonnencreme' })
	).toHaveCount(1);

	// The product photo renders on the shop tile (§9.1: list rows are text-only;
	// images live on shop tiles and in the product details sheet).
	await openShopView(pageA);
	const tileA = pageA.locator('[data-testid="tile"]', { hasText: 'Testprodukt Sonnencreme' });
	await expect(tileA).toBeVisible();
	await expect(tileA.locator('[data-testid="tile-photo"]')).toHaveAttribute('src', FAKE_IMAGE_URL);

	// Second client converges and renders the picture, not just the name.
	// Its service worker is active first, so the reload below is controlled
	// and the photo request goes through it.
	await pageB.evaluate(() => navigator.serviceWorker.ready);
	await pageB.reload();
	await openShopView(pageB);
	const tileB = pageB.locator('[data-testid="tile"]', { hasText: 'Testprodukt Sonnencreme' });
	await expect(tileB).toBeVisible({ timeout: 15_000 });
	await expect(tileB.locator('[data-testid="tile-photo"]')).toHaveAttribute('src', FAKE_IMAGE_URL);
	// The image actually decodes (not a broken-image placeholder) — proves the
	// stub is wired through the real <img> tag Playwright/Chromium fetches.
	await expect(async () => {
		const naturalWidth = await tileB
			.locator('[data-testid="tile-photo"]')
			.evaluate((img: HTMLImageElement) => img.naturalWidth);
		expect(naturalWidth).toBeGreaterThan(0);
	}).toPass({ timeout: 10_000 });

	// §9.2 "SW-cached" [D-21]: the service worker kept the photo…
	await expect.poll(() => photoCached(pageB), { timeout: 10_000 }).toBe(true);

	// …so it is still there offline, after a reload. Not page.reload(): CDP's
	// offline emulation can abort it before the worker sees it (pwa.spec.ts).
	await ctxB.setOffline(true);
	// Waited for from before the reload: waitForLoadState would see the old
	// page, already loaded, and return at once.
	const reloaded = pageB.waitForEvent('load');
	await pageB.evaluate(() => location.reload());
	await reloaded;
	await openShopView(pageB);
	const offlinePhoto = pageB
		.locator('[data-testid="tile"]', { hasText: 'Testprodukt Sonnencreme' })
		.locator('[data-testid="tile-photo"]');
	await expect(async () => {
		const naturalWidth = await offlinePhoto.evaluate((img: HTMLImageElement) => img.naturalWidth);
		expect(naturalWidth).toBeGreaterThan(0);
	}).toPass({ timeout: 15_000 });
	await ctxB.setOffline(false);

	// §5.6 [D-55]: signing out on this device empties the photo cache, which is
	// origin-wide and would show the next person what this account scanned.
	// No passkey sign-in straight back after the sign-out.
	await disableConditionalMediation(pageB, { acrossNavigations: true });
	await pageB.goto('/settings');
	await pageB.getByRole('button', { name: 'Auf diesem Gerät abmelden' }).click();
	await expect(pageB.getByLabel('Spitzname', { exact: true })).toBeVisible();
	await expect.poll(() => pageB.evaluate(() => caches.has('photos'))).toBe(false);

	await ctxA.close();
	await ctxB.close();
});

/** Whether the service worker's `photos` cache holds the product photo. Asks
 *  `caches.has` first: opening a missing cache would create it. */
function photoCached(page: Page): Promise<boolean> {
	return page.evaluate(
		async (url) =>
			(await caches.has('photos')) &&
			(await (await caches.open('photos')).match(url)) !== undefined,
		FAKE_IMAGE_URL
	);
}
