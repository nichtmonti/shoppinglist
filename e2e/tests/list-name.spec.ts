import { expect, test } from './fixtures';
import { createList, registerAccount, shareListWith } from './helpers';

// [D-08]: a list has one name, every member's. The joiner sees the name the
// list already has, and a rename by either member reaches the other, so two
// people can tell from their screens that they mean the same list.
test('the joiner sees the list by its name, and a rename reaches the other member', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Getränke');

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	// The ▾ quick-switcher trigger carries the list's name.
	await expect(pageB.getByRole('button', { name: 'Getränke', exact: true })).toBeVisible({
		timeout: 15_000
	});

	await pageB.getByTestId('list-menu').click();
	await pageB.getByRole('button', { name: 'Umbenennen', exact: true }).click();
	const dialog = pageB.getByRole('dialog', { name: 'Umbenennen' });
	// The field opens focused with its name selected, so typing replaces it.
	const field = dialog.getByLabel('Name');
	await expect(field).toBeFocused();
	await expect
		.poll(() => field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
		.toEqual([0, 'Getränke'.length]);
	await field.fill('Getränke & Snacks');
	await dialog.getByRole('button', { name: 'Speichern' }).click();
	await expect(pageB.getByRole('button', { name: 'Getränke & Snacks', exact: true })).toBeVisible();

	// A's next sync cycle carries the new name; a reload starts one.
	await pageA.reload();
	await expect(pageA.getByRole('button', { name: 'Getränke & Snacks', exact: true })).toBeVisible({
		timeout: 15_000
	});

	await ctxA.close();
	await ctxB.close();
});
