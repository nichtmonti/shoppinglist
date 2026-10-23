import { expect, test, type Page } from './fixtures';
import { addVirtualAuthenticator, registerAccount } from './helpers';

// A passkey's row is a button named by the passkey's name ([D-269]).
const passkeyRows = (page: Page) => page.getByTestId('passkey-row');
const passkeyRow = (page: Page, name: string) =>
	passkeyRows(page).and(page.getByRole('button', { name, exact: true }));

// [D-205] Settings opens whole: every frame from the click on shows the
// account's passkey, not the group without it and then the rows pushing in.
test('settings opens with its passkeys: no frame without them', async ({ page }) => {
	await registerAccount(page, 'Ganz');
	await page.goto('/');
	const link = page.getByRole('link', { name: 'Einstellungen' });
	await link.waitFor();
	await page.evaluate(() => {
		const w = window as unknown as { __frames: number[]; __recording: boolean };
		w.__frames = [];
		w.__recording = true;
		const tick = () => {
			if (!w.__recording) return;
			if (document.querySelector('h1')?.textContent?.trim() === 'Einstellungen') {
				w.__frames.push(document.querySelectorAll('[data-testid="passkey-row"]').length);
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await link.click();
	await expect(passkeyRows(page)).toHaveCount(1);
	// eslint-disable-next-line playwright/no-wait-for-timeout -- the frames recorded meanwhile are the check
	await page.waitForTimeout(500);
	const frames = await page.evaluate(() => {
		const w = window as unknown as { __frames: number[]; __recording: boolean };
		w.__recording = false;
		return w.__frames;
	});
	expect(frames.length).toBeGreaterThan(0);
	expect(frames.filter((rows) => rows !== 1)).toEqual([]);
});

// §4.3, §5.4 — managing passkeys from settings: add a second one, rename it,
// then remove the first. The second passkey is the ONLY account-recovery path
// (§4.3: lose the one passkey, lose the account), and adding one is an
// authenticated ceremony (addPasskey() in #lib/auth/passkey.ts sends the session's
// Authorization header on finish).
//
// The second authenticator: registerBegin excludes the account's existing
// credentials (excludeCredentials), so the ceremony needs an authenticator that
// does not hold the first passkey — a `usb` security key, since Chromium allows
// only one `internal` one per environment.

test('managing passkeys in settings: add a second, rename it, then remove the first', async ({
	browser
}) => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await registerAccount(page, 'Peer');

	await addVirtualAuthenticator(page, { transport: 'usb' });

	await page.goto('/settings');
	await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();

	// One passkey to start (the one registerAccount minted), unnamed.
	await expect(passkeyRows(page)).toHaveCount(1);

	// Add a second, named passkey: the row asks for the name first.
	await page.getByRole('button', { name: 'Passkey hinzufügen' }).click();
	await page.getByLabel('Name für den neuen Passkey').fill('Zweitgerät');
	await page.getByRole('dialog').getByRole('button', { name: 'Passkey hinzufügen' }).click();
	await expect(passkeyRows(page)).toHaveCount(2, { timeout: 15_000 });
	// No failure banner from the ceremony.
	await expect(page.getByRole('alert')).toHaveCount(0);

	// Rename the new one, from its sheet.
	await passkeyRow(page, 'Zweitgerät').click();
	await page.getByRole('button', { name: 'Umbenennen' }).click();
	await page.getByRole('textbox', { name: 'Name' }).fill('Büro-Yubikey');
	await page.getByRole('button', { name: 'Speichern' }).click();
	await expect(passkeyRow(page, 'Büro-Yubikey')).toBeVisible();

	// The group's list comes from the server (listPasskeys() -> GET
	// credentials, §11 own-row), not local state — a reload re-fetches it, so
	// this is proof the rename actually reached /api/credentials/{id}/rename
	// rather than just updating this row in memory.
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
	await expect(passkeyRow(page, 'Büro-Yubikey')).toBeVisible({ timeout: 15_000 });

	// Remove the original, UNNAMED passkey, matched on its exact label.
	await passkeyRow(page, 'Passkey').click();
	await page.getByRole('button', { name: 'Passkey entfernen' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen' }).click();
	await expect(passkeyRows(page)).toHaveCount(1, { timeout: 15_000 });
	await expect(passkeyRow(page, 'Büro-Yubikey')).toBeVisible();

	// And it stays gone after a reload — again, proof against the server's
	// own row set, not a locally-cached list.
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
	await expect(passkeyRows(page)).toHaveCount(1, { timeout: 15_000 });
	await expect(passkeyRow(page, 'Büro-Yubikey')).toBeVisible();

	await ctx.close();
});
