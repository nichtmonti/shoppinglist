import { aimCamera, installCamera } from './camera';
import { expect, test } from './fixtures';
import {
	createList,
	FAKE_BARCODE,
	itemRow,
	openListView,
	registerAccount,
	stubBarcodeLookup
} from './helpers';

// The barcode decoder, for real ([D-21]). scan.spec.ts skips it
// (__e2eFakeBarcode) to test what a scan does; this is the one browser test
// that decodes: a camera stream with a real EAN-13 in it (camera.ts), read by
// the decoder the app ships — barcode-detector's glue and the zxing-wasm
// binary Vite bundles. From v0.5.3 to [D-21] those two came from different
// zxing-wasm builds, every detect() threw "memory access out of bounds" (this
// headless browser crashed the tab outright), and scanning was broken on every
// browser — the ponyfill never defers to a native BarcodeDetector; no test
// noticed. Only the lookup
// is stubbed, so the suite does not depend on Open Food Facts.
test('the shipped decoder reads a barcode from the camera', async ({ page }) => {
	const decodeErrors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error' && /memory access|RuntimeError/.test(m.text()))
			decodeErrors.push(m.text());
	});
	page.on('pageerror', (e) => decodeErrors.push(String(e)));
	await stubBarcodeLookup(page.context());
	await installCamera(page, FAKE_BARCODE);
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);

	await page.getByTestId('scan-trigger').click();
	await expect(page.locator('video')).toBeVisible();
	await aimCamera(page);

	// The stubbed lookup names the product, so the row proves the decoder
	// produced exactly FAKE_BARCODE: no other code reaches that name.
	await expect(itemRow(page, 'Testprodukt Sonnencreme')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('scan-message')).toHaveCount(0);
	expect(decodeErrors).toEqual([]);
});
