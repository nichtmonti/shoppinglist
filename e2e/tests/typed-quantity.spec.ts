import { expect, test } from './fixtures';
import { createList, openListView, registerAccount } from './helpers';

// [D-285] An amount typed with the name is the quantity: shown on the
// suggestion before the pick, set on the new row, and set on a row already on
// the list, while the field keeps focus (on a phone, the keyboard stays up).
test('an amount typed with the name becomes the quantity, and the field keeps focus', async ({
	page
}) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);

	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	const quantityOf = (q: string) =>
		page.getByRole('button', { name: `${q} – Menge bearbeiten: Milch` });

	await input.fill('2 l Milc');
	const milch = page.locator('[data-ta-name="Milch"]');
	await expect(milch).toBeVisible({ timeout: 15_000 });
	await expect(milch.locator('.ta-qty')).toHaveText('2 l');
	await input.press('Enter');
	await expect(quantityOf('2 l')).toBeVisible();
	await expect(input).toBeFocused();
	await expect(input).toHaveValue('');

	// Already on the list: no amount leaves it, an amount at the end sets it.
	await input.fill('Milch');
	await expect(milch).toBeVisible();
	await input.press('Enter');
	await expect(page.getByText('„Milch“ ist schon auf der Liste')).toBeVisible();
	await expect(quantityOf('2 l')).toBeVisible();

	await input.fill('Milch 3 l');
	await expect(milch.locator('.ta-qty')).toHaveText('3 l');
	await input.press('Enter');
	await expect(quantityOf('3 l')).toBeVisible();
	await expect(page.getByText('„Milch“ ist schon auf der Liste, Menge jetzt 3 l')).toBeVisible();
	await expect(input).toBeFocused();
});
