import { expect, test } from './fixtures';
import { createList, registerAccount } from './helpers';

// [D-237] A tap on an arrangement's grip brings out that row's arrows, and a
// second tap puts them away, by touch as by mouse. The grip is
// svelte-dnd-action's drag handle, whose touchstart cancels the browser's own
// click; the library sends one when the touch ends without a drag, and the row
// counts it once.
test.use({ hasTouch: true });

test("a tap on a grip toggles that row's arrows, by touch and by mouse", async ({ page }) => {
	await registerAccount(page, 'Clara');
	await createList(page, 'Speisekammer');
	await page.getByTestId('list-menu').click();
	await page
		.getByRole('dialog', { name: 'Speisekammer' })
		.getByRole('button', { name: 'Kategorien bearbeiten' })
		.click();
	await page.getByRole('button', { name: 'Reihenfolge ändern' }).click();

	const grip = page.getByRole('button', { name: 'Brot & Backwaren verschieben' });
	const down = page.getByRole('button', { name: 'Brot & Backwaren nach unten' });

	await grip.tap();
	await expect(down).toBeVisible();
	await grip.tap();
	await expect(down).toHaveCount(0);

	await grip.click();
	await expect(down).toBeVisible();
	await grip.click();
	await expect(down).toHaveCount(0);
});
