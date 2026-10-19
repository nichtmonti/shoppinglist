import { expect, test, type Locator, type Page } from './fixtures';
import { addItemByTyping, addVirtualAuthenticator, createList, openListView } from './helpers';

// iOS Safari zooms the viewport whenever a focused text control computes below
// 16 CSS px, and never zooms back on blur. The app removes the trigger, not
// the ability: pinch-zoom stays (WCAG 1.4.4), so every text control has to
// clear 16px on its own.
//
// Two things can defeat that floor, and each hides behind the other:
//
//  - An unlayered `input, textarea { font: inherit }` in app.css. Tailwind's
//    utilities live in @layer utilities, and unlayered CSS outranks every
//    layer, so each field's `text-base` would lose to its container: the
//    detail sheet and dialogs are `text-sm`, so their fields would render at
//    14px everywhere.
//  - A `md:text-sm` on the vendored shadcn Input. A call site's `text-base`
//    cannot cancel it (tailwind-merge only dedupes classes under the same
//    variant), so every Input would drop to 14px from 768px up — and an
//    iPhone 17 held landscape is 874px wide.
//
// Hence two viewports: portrait alone passes with the second one present.
//
// WebKit is not in the harness (Chromium only), so this asserts the trigger —
// the computed size — rather than the zoom itself.

const VIEWPORTS = [
	{ name: 'phone portrait', width: 402, height: 874 },
	{ name: 'phone landscape', width: 874, height: 402 }
];

/** Every visible control that brings up a keyboard, with its computed size. */
async function textControls(page: Page): Promise<{ id: string; px: number }[]> {
	return page.evaluate(() => {
		const nonText = new Set([
			'checkbox',
			'radio',
			'file',
			'range',
			'color',
			'hidden',
			'button',
			'submit',
			'reset',
			'image'
		]);
		const els = Array.from(
			document.querySelectorAll<HTMLElement>(
				'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
			)
		).filter((el) => {
			if (el instanceof HTMLInputElement && nonText.has(el.type)) return false;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
		});
		return els.map((el) => ({
			id: el.id || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.className,
			px: parseFloat(getComputedStyle(el).fontSize)
		}));
	});
}

/**
 * `field` is the control the surface must show: the scan is a one-shot
 * snapshot, so it waits for that first — and the scan still covers every
 * other text control on screen, not just this one.
 */
async function expectNoZoom(page: Page, surface: string, field: Locator): Promise<void> {
	await expect(field, `${surface}: its text control never appeared`).toBeVisible();
	const small = (await textControls(page)).filter((c) => c.px < 16);
	expect(small, `${surface}: text controls below 16px make iOS Safari zoom on focus`).toEqual([]);
}

for (const vp of VIEWPORTS) {
	test.describe(vp.name, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test(`no text control is below the 16px focus-zoom floor (${vp.width}px)`, async ({ page }) => {
			await addVirtualAuthenticator(page);
			await page.goto('/');
			const nickname = page.getByLabel('Spitzname', { exact: true });
			await expectNoZoom(page, 'auth screen', nickname);

			await nickname.fill(`Zoom${vp.width}`);
			await page.getByRole('button', { name: 'Konto erstellen' }).click();
			await expect(page.getByText('Willkommen!')).toBeVisible({ timeout: 15_000 });

			await page.getByRole('button', { name: 'Neue Liste' }).first().click();
			const prompt = page.getByRole('dialog', { name: 'Neue Liste' });
			await expectNoZoom(page, 'new-list prompt', prompt.getByLabel('Name der Liste'));
			await page.keyboard.press('Escape');

			const listUrl = await createList(page, 'Zoomprobe');
			await openListView(page);
			await expectNoZoom(
				page,
				'list view',
				page.getByRole('combobox', { name: 'Artikel hinzufügen' })
			);

			await addItemByTyping(page, 'Zoommilch');
			const row = page.locator('[data-testid="row"]').filter({ hasText: 'Zoommilch' });
			await row.locator('.qty').click();
			await expectNoZoom(page, 'inline quantity editor', row.locator('.qty-edit'));
			await page.keyboard.press('Escape');

			await row.locator('.row-name').click();
			await expectNoZoom(page, 'item detail sheet', page.locator('#detail-note'));
			await page.keyboard.press('Escape');

			await page.goto('/settings');
			// The nickname row opens its prompt ([D-269]).
			await page.getByRole('button', { name: /^Spitzname/ }).click();
			await expectNoZoom(page, 'settings', page.getByRole('textbox', { name: 'Spitzname' }));
			await page.keyboard.press('Escape');

			await page.goto(`${listUrl}/categories`);
			await page.getByTestId('ce-add').click();
			await expectNoZoom(page, 'category form', page.locator('#ce-form-name'));
		});
	});
}
