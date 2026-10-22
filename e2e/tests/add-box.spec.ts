import { expect, test } from './fixtures';
import {
	addItemByTyping,
	chooseItemSort,
	createList,
	itemRow,
	openListView,
	openShopView,
	registerAccount
} from './helpers';

// The list view's add box, as only a real browser shows it: where focus lands
// and what scrolls. happy-dom has neither layout nor a viewport, and the arch
// walk sees the view change but not the focus.

// [D-213] The shop view's pencil goes to edit the list, which starts with
// typing: the add box arrives focused, so the keyboard is up at once.
test('„Liste bearbeiten" in the shop view opens the list view with the add box focused', async ({
	page
}) => {
	await registerAccount(page, 'Lena');
	await createList(page, 'Markt');
	await openShopView(page);

	await page.getByRole('button', { name: 'Liste bearbeiten', exact: true }).click();

	await expect(page.getByRole('combobox', { name: 'Artikel hinzufügen' })).toBeFocused();
});

// §9.1 dedup-aware typeahead: a name the list already holds is not added
// again; the add box jumps to the existing row, scrolling it into view, and
// keeps focus for the next name.
test('adding a name already on a long list scrolls to its row instead of adding it again', async ({
	page
}) => {
	await registerAccount(page, 'Jonas');
	await createList(page, 'Vorrat');
	await openListView(page);
	// A–Z with numeric collation puts „Posten-30" last. No name is a prefix
	// of a later one, so Enter always adds what was typed; the hyphen keeps
	// each number in the name, where „Posten 30" would be 30 × Posten ([D-285]).
	await chooseItemSort(page, 'az');
	for (let n = 1; n <= 30; n++) await addItemByTyping(page, `Posten-${n}`);
	const rows = page.locator('[data-testid="row"]');
	await expect(rows).toHaveCount(30, { timeout: 15_000 });

	const last = itemRow(page, 'Posten-30');
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
	await expect(last, 'the list must be long enough to hide its last row').not.toBeInViewport();

	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill('Posten-30');
	await input.press('Enter');
	// The add has run once the box empties; the count and the focus below held
	// before it too.
	await expect(input).toHaveValue('');

	await expect(last).toBeInViewport();
	await expect(input).toBeFocused();
	await expect(rows).toHaveCount(30);
});

// [D-290] The + is drawn over the input, so a tap on it is a tap on the field.
test('a tap on the add field’s + opens the field', async ({ page }) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);

	const plus = (await page.locator('.add-plus').boundingBox())!;
	await page.mouse.click(plus.x + plus.width / 2, plus.y + plus.height / 2);
	await expect(page.getByRole('combobox', { name: 'Artikel hinzufügen' })).toBeFocused();
});
