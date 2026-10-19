import { expect, test } from './fixtures';
import {
	addItemByTyping,
	backOverLayer,
	chooseItemSort,
	createList,
	itemRow,
	openListView,
	openSameAccountDevice,
	registerAccount
} from './helpers';

// §6.7 [D-37]/[D-40] the per-list category ("aisle") editor: add / rename /
// hide / reorder / reset-to-default, all through #lib/actions/categories.ts.
// Every write here must cross the real server ([D-08]: a create that names
// the server-owned `slug` field is denied), and only this layer drives them
// all against it. One test, one account, one list: add a custom category,
// rename and re-emoji/re-color a seeded one, hide a different seeded one,
// reorder by keyboard (the zone's own documented mechanism —
// categories_dnd_instruction), and assign an item to the custom category —
// then prove all five crossed the server on a fresh same-account device.
// Finally restore the hidden row and reset the renamed one (a NULL name
// push) and prove those land too.
test('the category editor: add, rename, hide, reorder, restore and reset all reach a second device', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Clara');
	await createList(pageA, 'Speisekammer');

	async function openCategoryEditor(page: typeof pageA): Promise<void> {
		await page.getByTestId('list-menu').click();
		await page
			.getByRole('dialog', { name: 'Speisekammer' })
			.getByRole('button', { name: 'Kategorien bearbeiten' })
			.click();
		await expect(page).toHaveURL(/\/categories$/);
	}

	await openCategoryEditor(pageA);

	// ---- 1. add a custom category, with an emoji and a color ----
	await pageA.getByRole('button', { name: 'Neue Kategorie', exact: true }).click();
	const addForm = pageA.getByRole('dialog', { name: 'Neue Kategorie' });
	await addForm.getByLabel('Name').fill('Feinkost');
	await addForm.getByTestId('emoji-grid').getByRole('radio', { name: '🧄', exact: true }).click();
	await addForm.getByTestId('color-grid').getByRole('radio', { name: 'Pink', exact: true }).click();
	await addForm.getByRole('button', { name: 'Speichern' }).click();
	await expect(addForm).not.toBeVisible();
	await expect(pageA.locator('.catedit-row').filter({ hasText: 'Feinkost' })).toBeVisible();

	// ---- 2. rename a seeded category, and change its emoji/color too ----
	// "pantry" (Konserven & Vorräte) is unrenamed, so it shows its template's
	// default German label — that is how the row is found before this step.
	const pantryRow = pageA.locator('.catedit-row').filter({ hasText: 'Konserven & Vorräte' });
	await pantryRow.getByRole('button', { name: /bearbeiten$/ }).click();
	const editForm = pageA.getByRole('dialog', { name: 'Kategorie bearbeiten' });
	await editForm.getByLabel('Name').fill('Speisekammer');
	await editForm.getByTestId('emoji-grid').getByRole('radio', { name: '🌿', exact: true }).click();
	await editForm
		.getByTestId('color-grid')
		.getByRole('radio', { name: 'Petrol', exact: true })
		.click();
	await editForm.getByRole('button', { name: 'Speichern' }).click();
	await expect(editForm).not.toBeVisible();
	await expect(pageA.locator('.catedit-row').filter({ hasText: 'Speisekammer' })).toBeVisible();

	// ---- 3. hide a different seeded category ----
	const meatRow = pageA.locator('.catedit-row').filter({ hasText: 'Fleisch & Fisch' });
	await meatRow.getByRole('button', { name: /ausblenden$/ }).click();
	await expect(pageA.locator('.hidden-row').filter({ hasText: 'Fleisch & Fisch' })).toBeVisible();

	// ---- 4. reorder: move "Brot & Backwaren" past "Milch & Kühlregal" ----
	// [D-90] Reordering is its own mode, and the arrows are its single-pointer
	// path (a pointer drag against svelte-dnd-action is the flaky one to fake).
	const labelsBefore = await pageA.locator('.catedit-row .ce-label').allTextContents();
	const bakeryIndex = labelsBefore.indexOf('Brot & Backwaren');
	expect(bakeryIndex).toBeGreaterThanOrEqual(0);
	const labelsAfter = [...labelsBefore];
	[labelsAfter[bakeryIndex], labelsAfter[bakeryIndex + 1]] = [
		labelsAfter[bakeryIndex + 1],
		labelsAfter[bakeryIndex]
	];
	await pageA.getByRole('button', { name: 'Reihenfolge ändern' }).click();
	// A tap on the handle brings out that row's arrows ([D-237]).
	await pageA.getByRole('button', { name: 'Brot & Backwaren verschieben' }).click();
	await pageA.getByRole('button', { name: 'Brot & Backwaren nach unten' }).click();
	// The mode is a history entry: the browser's back closes it and stays on
	// the editor ("Fertig" is the dead-controls harness's to press).
	await backOverLayer(pageA, 'mode');
	await expect(pageA.getByRole('button', { name: 'Fertig' })).toHaveCount(0);
	await expect(pageA).toHaveURL(/\/categories$/);
	// swapSortOrder writes the two rows' sort_order one at a time, so the pair
	// briefly shares a value and sortCategories' alphabetical tie-break flickers
	// the DOM through the OLD order before settling — toHaveText's own retrying
	// is what waits that out, rather than a one-shot read racing the flicker.
	await expect(pageA.locator('.catedit-row .ce-label')).toHaveText(labelsAfter, {
		timeout: 10_000
	});

	// ---- 5. add an item, assign it to the custom category ----
	await pageA.getByRole('button', { name: 'Zurück', exact: true }).click();
	await expect(pageA).not.toHaveURL(/\/categories$/);
	await openListView(pageA);
	await chooseItemSort(pageA, 'az');
	await addItemByTyping(pageA, 'Trüffelöl');
	await itemRow(pageA, 'Trüffelöl').getByRole('button', { name: 'Trüffelöl', exact: true }).click();
	const itemDetails = pageA.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await itemDetails.getByRole('radio', { name: 'Feinkost', exact: true }).click();
	await pageA.keyboard.press('Escape');

	// Proof the writes reached the server, not just the local mirror.
	await expect(pageA.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});
	await expect(pageA.getByText(/konnte nicht synchronisiert werden/)).toHaveCount(0);

	// ---- device B: a fresh mirror — everything above must be visible ----
	const { context: ctxB, page: pageB } = await openSameAccountDevice(browser, pageA);
	await pageB.getByRole('link', { name: 'Speisekammer öffnen' }).click();
	await openListView(pageB);
	await chooseItemSort(pageB, 'az');
	await expect(
		itemRow(pageB, 'Trüffelöl').getByRole('button', { name: /Feinkost.*Trüffelöl/ })
	).toBeVisible({ timeout: 15_000 });

	await openCategoryEditor(pageB);
	await expect(pageB.locator('.catedit-row').filter({ hasText: 'Feinkost' })).toBeVisible();
	await expect(pageB.locator('.catedit-row').filter({ hasText: 'Speisekammer' })).toBeVisible();
	await expect(pageB.locator('.hidden-row').filter({ hasText: 'Fleisch & Fisch' })).toBeVisible();
	await expect(pageB.locator('.catedit-row .ce-label')).toHaveText(labelsAfter);

	// ---- back on A: restore the hidden category, reset the renamed one ----
	await openCategoryEditor(pageA);
	await pageA
		.locator('.hidden-row')
		.filter({ hasText: 'Fleisch & Fisch' })
		.getByRole('button', { name: 'Wiederherstellen' })
		.click();
	await expect(pageA.locator('.catedit-row').filter({ hasText: 'Fleisch & Fisch' })).toBeVisible();

	await pageA
		.locator('.catedit-row')
		.filter({ hasText: 'Speisekammer' })
		.getByRole('button', { name: /bearbeiten$/ })
		.click();
	const resetForm = pageA.getByRole('dialog', { name: 'Kategorie bearbeiten' });
	// Reset writes `name: null` — no layer had ever pushed that before this spec.
	await resetForm.getByRole('button', { name: 'Auf Standard zurücksetzen' }).click();
	await expect(resetForm).not.toBeVisible();
	await expect(
		pageA.locator('.catedit-row').filter({ hasText: 'Konserven & Vorräte' })
	).toBeVisible();
	await expect(pageA.locator('.catedit-row').filter({ hasText: 'Speisekammer' })).toHaveCount(0);

	await expect(pageA.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});
	await expect(pageA.getByText(/konnte nicht synchronisiert werden/)).toHaveCount(0);

	// ---- device B again, reloaded for convergence: both originals are back ----
	await pageB.reload();
	await expect(pageB).toHaveURL(/\/categories$/);
	await expect(pageB.locator('.catedit-row').filter({ hasText: 'Fleisch & Fisch' })).toBeVisible();
	await expect(
		pageB.locator('.catedit-row').filter({ hasText: 'Konserven & Vorräte' })
	).toBeVisible();
	await expect(pageB.locator('.catedit-row').filter({ hasText: 'Speisekammer' })).toHaveCount(0);
	await expect(pageB.locator('.hidden-row')).toHaveCount(0);

	await ctxA.close();
	await ctxB.close();
});
