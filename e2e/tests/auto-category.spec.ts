import { expect, test } from './fixtures';
import {
	addItemByTyping,
	chooseItemSort,
	createList,
	itemRow,
	openListView,
	registerAccount
} from './helpers';

// §9 head-noun auto-categorisation [D-48], end to end against the REAL seed.
//
// The unit and component layers prove the algorithm and the wiring, but both
// hand-feed the dictionary. This is the only layer that shows the mirrored
// 414-entry `item_dictionary` (§6.9) reaching the classifier in a real browser
// and the result landing on the row the shopper actually looks at — the A→Z
// category chip, whose aria-label carries the aisle name (§9.1).
test('a typed novel compound gets its head noun’s aisle, not Others', async ({ page }) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);
	await chooseItemSort(page, 'az');

	// The dictionary mirror arrives on the first sync drain, so wait for proof it
	// is there — a seeded suggestion — before typing anything that depends on it.
	// Otherwise this races the mirror and the item silently lands in Sonstiges.
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill('Schokolad');
	await expect(page.locator('[data-ta-name="Schokolade"]')).toBeVisible({ timeout: 15_000 });
	await input.fill('');

	// "Vollmilchschokolade" is NOT in the seed. A prefix matcher would see
	// "Vollmilch" and file it under Milchprodukte; the head noun says sweets.
	await addItemByTyping(page, 'Vollmilchschokolade');
	const row = itemRow(page, 'Vollmilchschokolade');
	await expect(row).toBeVisible();
	await expect(row.locator('[data-testid="cat-chip"]')).toHaveAttribute(
		'aria-label',
		/^Snacks & Süßigkeiten, /
	);

	// The control: nothing in the seed ends in "-marken", so this still falls to
	// the Others bucket (§6.6) — the classifier guesses, it does not force.
	await addItemByTyping(page, 'Briefmarken');
	const control = itemRow(page, 'Briefmarken');
	await expect(control).toBeVisible();
	await expect(control.locator('[data-testid="cat-chip"]')).toHaveAttribute(
		'aria-label',
		/^Sonstiges, /
	);

	// And the chip is still the door into the detail sheet, so a wrong guess is
	// two taps from fixed (§9.1).
	await row.locator('[data-testid="cat-chip"]').click();
	await expect(page.getByRole('dialog')).toBeVisible();
});
