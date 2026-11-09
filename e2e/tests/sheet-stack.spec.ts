// A sheet and a confirmation opened over it are both bits-ui dialogs
// ([D-348]): the confirmation keeps Escape, taps and focus to itself.
import { expect, test } from './fixtures';
import { createList, registerAccount, showInviteLink } from './helpers';

test('a confirmation over the sheet keeps Escape, taps and focus', async ({ page }) => {
	await registerAccount(page, 'Stack');
	await createList(page, 'Stapel');
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	// By its element: under the confirmation it leaves the accessibility tree.
	const sheet = page.locator('[data-slot="sheet-content"]', {
		has: page.locator('[data-dialog-title]', { hasText: 'Teilen & Mitglieder' })
	});
	await expect(sheet).toBeVisible();
	await showInviteLink(page);

	await page.getByRole('button', { name: 'Link zurücksetzen' }).click();
	const confirm = page.getByRole('alertdialog');
	await expect(confirm).toBeVisible();

	// Focus is in the confirmation, and Tab keeps it there.
	const focusInConfirm = () =>
		page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'));
	await expect.poll(focusInConfirm).toBe(true);
	for (let i = 0; i < 4; i++) {
		await page.keyboard.press('Tab');
		expect(await focusInConfirm()).toBe(true);
	}

	// A tap on the confirmation's own text closes nothing.
	await confirm.getByRole('heading').first().click();
	await expect(confirm).toBeVisible();
	await expect(sheet).toBeVisible();

	// Escape closes the confirmation only, then the sheet.
	await page.keyboard.press('Escape');
	await expect(confirm).toBeHidden();
	await expect(sheet).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
});
