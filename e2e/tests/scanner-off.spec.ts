import { expect, test, type Page } from './fixtures';
import { createList, openListView, registerAccount } from './helpers';

// [D-218] An instance with SHOPPINGLIST_SCANNER=off stamps
// <meta name="shoppinglist-scanner" content="off"> into its shell. The harness
// server runs with the scanner on, so this spec stamps the tag itself into
// every document the server sends — the same bytes internal/ui would write —
// and checks what only a real layout can: with the scan button gone, the text
// takes the add field's full width, rather than leaving the button's slot
// empty inside it ([D-277]). Go's ui_test.go holds the stamping end.
//
// Service workers are blocked so every navigation reaches page.route; a
// worker-served shell would bypass the stamp.
test.use({ serviceWorkers: 'block' });

async function stampScannerOff(page: Page): Promise<void> {
	await page.route('**/*', async (route) => {
		if (route.request().resourceType() !== 'document') return route.continue();
		const response = await route.fetch();
		const body = (await response.text()).replace(
			/<head([^>]*)>/i,
			'<head$1><meta name="shoppinglist-scanner" content="off" />'
		);
		return route.fulfill({ response, body });
	});
}

async function fieldAndBand(page: Page) {
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await expect(input).toBeVisible();
	const text = await input.boundingBox();
	const field = await page.locator('.add-field').boundingBox();
	const band = await page.locator('.addbar').boundingBox();
	if (!text || !field || !band) throw new Error('add bar not laid out');
	return { text, field, band };
}

test('with the scanner off the add bar has no scan button and the field fills the band', async ({
	page
}) => {
	await stampScannerOff(page);
	await registerAccount(page, 'Pia');
	await createList(page, 'Wocheneinkauf');
	await openListView(page);

	const { text, field, band } = await fieldAndBand(page);
	await expect(page.getByTestId('scan-trigger')).toHaveCount(0);

	// px-3.5 on .addbar: 14px each side, and nothing else in the row.
	const padding = 14;
	expect(field.x - band.x).toBeCloseTo(padding, 0);
	expect(band.x + band.width - (field.x + field.width)).toBeCloseTo(padding, 0);
	// The text runs to the field's end, inside its 1px border.
	expect(field.x + field.width - (text.x + text.width)).toBeLessThanOrEqual(1.5);
});

test('unstamped, the scan button sits inside the field, at its end', async ({ page }) => {
	await registerAccount(page, 'Pia');
	await createList(page, 'Wocheneinkauf');
	await openListView(page);

	const { text, field } = await fieldAndBand(page);
	const scan = await page.getByTestId('scan-trigger').boundingBox();
	if (!scan) throw new Error('scan button not laid out');
	// The control proves the measurement above means something: here the text
	// stops well short of the field's end, where the button sits.
	expect(field.x + field.width - (text.x + text.width)).toBeGreaterThan(30);
	// It may sit over the input's 12px end padding (pe-3), never over its text.
	expect(scan.x).toBeGreaterThanOrEqual(text.x + text.width - 12);
	expect(scan.x + scan.width).toBeLessThanOrEqual(field.x + field.width);
});
