// A sheet and a confirmation opened over it are both bits-ui dialogs
// ([D-348]): the confirmation keeps Escape, taps and focus to itself, and
// both animate.
import { expect, test, type Locator, type Page } from './fixtures';
import { createList, registerAccount, showInviteLink } from './helpers';

/** The share sheet, with a live link to reset. */
async function openShareSheet(page: Page, who: string): Promise<Locator> {
	await registerAccount(page, who);
	await createList(page, 'Stapel');
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	// By its element: under the confirmation it leaves the accessibility tree.
	const sheet = page.locator('[data-slot="sheet-content"]', {
		has: page.locator('[data-dialog-title]', { hasText: 'Teilen & Mitglieder' })
	});
	await expect(sheet).toBeVisible();
	await showInviteLink(page);
	return sheet;
}

test('a confirmation over the sheet keeps Escape, taps and focus', async ({ page }) => {
	const sheet = await openShareSheet(page, 'Stack');

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

// bits-ui marks a dialog's state as data-state; parts keyed on data-open
// never animated at all. The confirmation is mounted only while it is
// asked (ShareSheet's `{#if}`), so it leaves at once; the sheet stays
// mounted, and it and the scrim animate out.
test('a confirmation animates in, and a sheet and its scrim animate out', async ({ page }) => {
	const sheet = await openShareSheet(page, 'Motion');
	await page.evaluate(() => {
		const w = window as unknown as { started: string[] };
		w.started = [];
		document.addEventListener('animationstart', (e) => {
			const slot = (e.target as HTMLElement).dataset.slot ?? '?';
			w.started.push(`${slot} ${e.animationName}`);
		});
	});
	const started = () => page.evaluate(() => (window as unknown as { started: string[] }).started);

	await page.getByRole('button', { name: 'Link zurücksetzen' }).click();
	await expect
		.poll(started)
		.toEqual(expect.arrayContaining(['alert-dialog-content enter', 'alert-dialog-overlay enter']));
	await page.keyboard.press('Escape');
	await expect(page.getByRole('alertdialog')).toBeHidden();

	await page.keyboard.press('Escape');
	await expect
		.poll(started)
		.toEqual(expect.arrayContaining(['sheet-content exit', 'dialog-overlay exit']));
	await expect(sheet).toBeHidden();
});
