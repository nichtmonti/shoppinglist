import { expect, test } from './fixtures';
import {
	addItemByTyping,
	createList,
	itemRow,
	openListView,
	openShopView,
	openSameAccountDevice,
	registerAccount
} from './helpers';

// §6.6/§9/§9.1 E2E: every edit an item can go through against a real server.
// Elsewhere the E2E suite exercises only creation, check-off and an aisle
// change (category-sync.spec.ts); rename, quantity (both paths: detail sheet
// AND the row's inline chip), note, remove and un-check reach a real server
// only here and in the integration layer, which hand-builds its ops rather
// than driving the UI.
test('detail-sheet edits, the inline quantity chip, remove and restore all reach the server', async ({
	browser
}) => {
	const page = await (await browser.newContext()).newPage();
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);

	await addItemByTyping(page, 'Kekse');
	await addItemByTyping(page, 'Senf');
	await addItemByTyping(page, 'Radiergummi');
	await expect(itemRow(page, 'Kekse')).toBeVisible();
	await expect(itemRow(page, 'Senf')).toBeVisible();
	await expect(itemRow(page, 'Radiergummi')).toBeVisible();

	// --- item 1: the detail sheet's "fuller edits" — rename, quantity, note ---
	// [D-119]: the row's name button is the door, not an inline control.
	await itemRow(page, 'Kekse').locator('.row-name').click();
	const detail1 = page.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await expect(detail1).toBeVisible();
	// Each field commits on its own blur (no separate Save, see ListView's
	// header comment) — fill+blur each in turn rather than one fill-then-close
	// so all three commit paths are exercised individually.
	await detail1.locator('#detail-name').fill('Zwieback');
	await detail1.locator('#detail-name').blur();
	await detail1.locator('#detail-quantity').fill('2 Packungen');
	await detail1.locator('#detail-quantity').blur();
	await detail1.locator('#detail-note').fill('für Kinder');
	await detail1.locator('#detail-note').blur();
	await detail1.getByRole('button', { name: 'Schließen' }).click();
	await expect(detail1).toBeHidden();

	// --- item 2: the row's own inline 3-state quantity control (unset → editing → set) ---
	const senfRow = itemRow(page, 'Senf');
	await senfRow.getByRole('button', { name: 'Menge hinzufügen' }).click();
	const qtyInput = senfRow.getByRole('textbox', { name: 'Menge bearbeiten' });
	await qtyInput.fill('1 Glas');
	await qtyInput.press('Enter');
	await expect(senfRow.getByRole('button', { name: 'Menge bearbeiten' })).toContainText('1 Glas');

	// --- item 3: remove from the sheet's destructive header action, let the
	// undo toast pass on its own (never bought before, so the plain "entfernt"
	// wording, not the "…bleibt unter „Frühere Artikel“" one). ---
	await itemRow(page, 'Radiergummi').locator('.row-name').click();
	const detail3 = page.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await detail3.getByRole('button', { name: 'Radiergummi von der Liste entfernen' }).click();
	await expect(page.getByText('„Radiergummi“ entfernt')).toBeVisible();
	await expect(itemRow(page, 'Radiergummi')).toHaveCount(0);

	// --- shop view: check item 2 off, then restore it from the done pile ---
	await openShopView(page);
	await page.locator('[data-testid="tile"]', { hasText: 'Senf' }).click();
	await expect(page.locator('[data-testid="done-head"]')).toBeVisible();
	await page.locator('[data-testid="done-row"]', { hasText: 'Senf' }).click();
	// The only item that was ever checked off just got un-checked, so the
	// whole "Erledigt" section closes again.
	await expect(page.locator('[data-testid="done-head"]')).toHaveCount(0);
	await expect(page.locator('[data-testid="tile"]', { hasText: 'Senf' })).toBeVisible();

	// --- proof the writes reached the server: settle, no failure toast ---
	await expect(page.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});
	await expect(page.getByText(/konnte nicht synchronisiert werden/)).toHaveCount(0);

	// --- a fresh same-account device proves it, not a reload of A (Dexie
	// persists locally regardless of whether anything reached the server) ---
	const deviceB = await openSameAccountDevice(browser, page);
	const pageB = deviceB.page;
	await pageB.getByRole('link', { name: 'Wochenshop öffnen' }).click();
	await openListView(pageB);
	// Deterministic convergence, same as logout-everywhere/offline-shop: B's
	// mirror starts empty, so force the initial pull rather than race it.
	await pageB.reload();
	await openListView(pageB);

	const zwiebackRow = itemRow(pageB, 'Zwieback');
	await expect(zwiebackRow).toBeVisible({ timeout: 15_000 });
	await expect(zwiebackRow).toContainText('2 Packungen');
	await expect(zwiebackRow).toContainText('für Kinder');
	// The old name is really gone, not just superseded in the same row.
	await expect(itemRow(pageB, 'Kekse')).toHaveCount(0);

	const senfRowB = itemRow(pageB, 'Senf');
	await expect(senfRowB).toBeVisible();
	await expect(senfRowB).toContainText('1 Glas');
	// Active, not checked: shop view shows it outside "Erledigt".
	await openShopView(pageB);
	await expect(pageB.locator('[data-testid="done-row"]', { hasText: 'Senf' })).toHaveCount(0);
	await expect(pageB.locator('[data-testid="tile"]', { hasText: 'Senf' })).toBeVisible();

	await expect(itemRow(pageB, 'Radiergummi')).toHaveCount(0);

	await deviceB.context.close();
	await page.context().close();
});
