import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createList, openListView, registerAccount } from './helpers';

// [D-289] A planning row swiped left removes its item, with the
// undo toast; a short drag snaps back and opens nothing.

// A phone's touch: the row's `touch-action: pan-y` is what tells a swipe from
// a scroll there.
test.use({ hasTouch: true });

async function addItems(page: Page, ...names: string[]): Promise<void> {
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	for (const name of names) {
		await input.fill(name);
		await input.press('Enter');
		await expect(page.locator('[data-testid="row"]', { hasText: name })).toBeVisible();
	}
	await input.blur();
}

const rowOf = (page: Page, name: string) => page.locator('[data-testid="row"]', { hasText: name });

/** A touch drag through CDP, so the browser's own `touch-action` handling runs. */
async function touchDrag(page: Page, name: string, dx: number, dy = 0): Promise<void> {
	const box = (await rowOf(page, name).boundingBox())!;
	const x = box.x + box.width * 0.7;
	const y = box.y + box.height / 2;
	const cdp = await page.context().newCDPSession(page);
	const at = (f: number) => [{ x: x + dx * f, y: y + dy * f }];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
	for (let i = 1; i <= 12; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i / 12) });
		await page.waitForTimeout(16);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await cdp.detach();
}

test('a row swiped left is removed, and Rückgängig brings it back', async ({ page }) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);
	await addItems(page, 'Milch', 'Brot');

	await touchDrag(page, 'Milch', -260);
	await expect(rowOf(page, 'Milch')).toHaveCount(0);
	await expect(rowOf(page, 'Brot')).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// The adds left their own toasts, each with a Rückgängig.
	await page
		.getByRole('listitem')
		.filter({ hasText: '„Milch“ entfernt' })
		.getByRole('button', { name: 'Rückgängig' })
		.click();
	await expect(rowOf(page, 'Milch')).toBeVisible();
});

test('a short drag snaps back, a vertical one scrolls, and neither removes', async ({ page }) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);
	await addItems(page, 'Milch');

	await touchDrag(page, 'Milch', -30);
	await touchDrag(page, 'Milch', -120, 200);
	await page.waitForTimeout(300);

	await expect(rowOf(page, 'Milch')).toBeVisible();
	await expect(rowOf(page, 'Milch')).not.toHaveAttribute('style', /translateX/);
	await expect(page.getByTestId('swipe-under')).toHaveCount(0);
});
