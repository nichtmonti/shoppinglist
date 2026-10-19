import { expect, test } from './fixtures';
import {
	addItemByTyping,
	chooseItemSort,
	createList,
	itemRow,
	openListView,
	registerAccount,
	shareListWith
} from './helpers';

// Browser-level half of the failed-subscription regression. The state-machine
// test injects the subscribe failure; here the first category reassignment must
// cross a real live subscription with no reload or navigation fallback.
test('a custom item category reaches an open second device on the first change', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Wochenshop');
	await openListView(pageA);
	await chooseItemSort(pageA, 'az');

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	await openListView(pageB);
	await chooseItemSort(pageB, 'az');

	await addItemByTyping(pageA, 'Drachenfrucht Spezial');
	await expect(itemRow(pageB, 'Drachenfrucht Spezial')).toBeVisible({ timeout: 15_000 });

	await itemRow(pageA, 'Drachenfrucht Spezial')
		.getByRole('button', {
			name: 'Drachenfrucht Spezial',
			exact: true
		})
		.click();
	const details = pageA.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await details.getByRole('radio', { name: /Obst & Gemüse/ }).click();

	await expect(
		itemRow(pageB, 'Drachenfrucht Spezial').getByRole('button', {
			name: /Obst & Gemüse.*Drachenfrucht Spezial/
		})
	).toBeVisible({ timeout: 15_000 });

	await ctxA.close();
	await ctxB.close();
});
