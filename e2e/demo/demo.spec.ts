// The demo build's journeys ([D-234]). Each test is a different visitor with
// its own client address (tests/fixtures.ts): the start route allows three
// starts per address per 10 minutes.
import { expect, test } from '../tests/fixtures';
import { expireStoredToken, inviteLinkFor, openListView } from '../tests/helpers';
import type { Page } from '@playwright/test';

/** Press "Ausprobieren" on a fresh visit, which stays on the overview of the
 *  example lists, and open the weekly shop. */
async function startDemo(page: Page): Promise<void> {
	await page.goto('/');
	await page.getByTestId('demo-start').click();
	for (const name of ['Basics', 'Barbecue', 'Camping']) {
		await expect(page.getByRole('link', { name: `${name} öffnen` })).toBeVisible({
			timeout: 15_000
		});
	}
	await expect(page).toHaveURL(/\/$/);
	await page.getByRole('link', { name: 'Basics öffnen' }).click();
	await expect(page.getByRole('button', { name: 'Basics', exact: true })).toBeVisible();
}

test('a visitor gets in with one button, to the example lists and the demo notice', async ({
	page
}) => {
	await page.goto('/');
	// No passkey, no OIDC: the demo's own screen is the whole auth screen.
	await expect(page.getByRole('heading', { name: 'Einkaufsliste (Demo)' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Mit Passkey anmelden' })).toHaveCount(0);

	await startDemo(page);
	// The scanned products carry the photos the demo server keeps for them,
	// with no network ([D-234]): Spaghetti and the oat drink on this list.
	await page.getByTestId('view-toggle-shop').click();
	const photos = page.getByTestId('tile-photo');
	await expect(photos).toHaveCount(2);
	for (const photo of await photos.all()) {
		await expect(photo).toHaveAttribute('src', /^\/api\/barcode\/photo\/[0-9a-f]{32}$/);
	}
	await openListView(page);
	await expect(page.getByTestId('row').filter({ hasText: /\bMilch\b/ })).toBeVisible();
	// Quantities, notes and an item outside the dictionary, not just names.
	await expect(page.getByTestId('row').filter({ hasText: 'Käse' })).toContainText('Gouda');
	await expect(page.getByTestId('row').filter({ hasText: 'Geschenkpapier' })).toBeVisible();
	await expect(page.getByTestId('demo-banner')).toHaveText(/in 24 Stunden gelöscht/);
	// Earlier purchases, so "Frühere Artikel" is not empty.
	await page.getByRole('button', { name: /^Frühere Artikel/ }).click();
	await expect(page.getByText('Olivenöl')).toBeVisible();
});

test('a second visitor joins through the invite and sees changes arrive', async ({
	page,
	browser
}) => {
	await startDemo(page);
	const link = await inviteLinkFor(page);

	// One test, one address — the fixture's header carries into this context.
	const other = await (await browser.newContext()).newPage();
	await other.goto(link);
	await other.getByTestId('demo-start').click();
	await other.getByRole('button', { name: 'Beitreten' }).click();
	await expect(other).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	await openListView(other);

	await openListView(page);
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill('Honig');
	await input.press('Enter');
	await expect(other.getByTestId('row').filter({ hasText: 'Honig' })).toBeVisible({
		timeout: 15_000
	});
});

test('signing out deletes the demo account', async ({ page }) => {
	await startDemo(page);
	await page.goto('/settings');
	// Nothing to install, and no passkeys to manage, on a demo: checked once
	// the screen is there, which it is not yet right after the goto.
	await expect(page.getByRole('button', { name: 'Abmelden und löschen' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'App installieren' })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Passkeys' })).toHaveCount(0);

	await page.getByRole('button', { name: 'Abmelden und löschen' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
	await expect(page.getByTestId('demo-start')).toBeVisible({ timeout: 15_000 });
});

test('an expired demo offers a new one', async ({ page }) => {
	await startDemo(page);
	// The state a deleted account leaves: a session the server rejects, with
	// the record kept (§5.8).
	await expireStoredToken(page);
	await page.reload();
	const banner = page.getByTestId('demo-banner');
	await expect(banner).toContainText('Diese Demo ist abgelaufen');
	await banner.getByRole('button', { name: 'Neue Demo starten' }).click();
	await expect(page.getByTestId('demo-start')).toBeVisible({ timeout: 15_000 });
});
