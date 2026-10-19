import { expect, test } from './fixtures';
import {
	addItemByTyping,
	createList,
	itemRow,
	openListView,
	openSameAccountDevice,
	registerAccount,
	shareListWith
} from './helpers';

// §8.3/§8.4 [D-11] E2E: the server resolves a conflict first-committed-wins per
// field, and the client's job is to make the loser's screen match the winner AND
// say so — a passive one-line toast (§8.4), never a silent revert. Every layer
// below this drives the engine against fakes or a hand-built op; only here does
// a real conflict, produced by two real browsers racing over the real backend,
// end in the right German copy and the right pixels. See
// frontend/src/integration/engine/sync.integration.test.ts for the same three shapes
// (same-field partial, delete-vs-edit, duplicate-name merge) proven at the
// wire-contract level.
//
// One list, two members (Anna/Ben), three rounds — each round is B offline +
// edit, A online + the competing edit, B reconnect. The toast is a single slot
// (toasts.ts: "newest wins"), so each round's toast is asserted before the next
// round produces one.
test('passive conflict notices: same-field, delete-vs-edit and duplicate-name merge', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Wochenshop');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Milch'); // round 1: same-field quantity conflict
	await addItemByTyping(pageA, 'Butter'); // round 2: edit-vs-remove
	await expect(itemRow(pageA, 'Milch')).toBeVisible();
	await expect(itemRow(pageA, 'Butter')).toBeVisible();

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible({ timeout: 15_000 });
	await expect(itemRow(pageB, 'Butter')).toBeVisible({ timeout: 15_000 });

	// --- round 1: same field (`partial`) — both set Milch's quantity ---
	await ctxB.setOffline(true);
	await expect(pageB.getByTestId('sync-line')).toContainText('Offline');

	const milchB = itemRow(pageB, 'Milch');
	await milchB.getByRole('button', { name: 'Menge hinzufügen' }).click();
	await milchB.getByRole('textbox', { name: 'Menge bearbeiten' }).fill('5 Liter');
	await milchB.getByRole('textbox', { name: 'Menge bearbeiten' }).press('Enter');
	await expect(milchB.getByRole('button', { name: 'Menge bearbeiten' })).toContainText('5 Liter');

	// A commits first, online — server-first-commit is what makes A's value win.
	// Waited for via the actual /api/sync/push round-trip (not just the chip
	// text, which is debounced ~500ms behind the edit and can already read
	// "synced" from BEFORE this edit — a bare text check does not prove THIS
	// write reached the server first).
	const milchA = itemRow(pageA, 'Milch');
	await milchA.getByRole('button', { name: 'Menge hinzufügen' }).click();
	await milchA.getByRole('textbox', { name: 'Menge bearbeiten' }).fill('2 Liter');
	await Promise.all([
		pageA.waitForResponse((r) => r.url().includes('/api/sync/push') && r.ok()),
		milchA.getByRole('textbox', { name: 'Menge bearbeiten' }).press('Enter')
	]);

	// Reconnect and wait for B's OWN push round-trip (not just the chip text,
	// which is already showing "synced" from before this round and would let a
	// bare text check pass before B's queued op is even sent) — the toast is
	// emitted synchronously off that same response, so checking for it right
	// after this resolves leaves no window for it to have already timed out.
	await Promise.all([
		pageB.waitForResponse((r) => r.url().includes('/api/sync/push') && r.ok()),
		ctxB.setOffline(false)
	]);
	// German copy from de.json: sync_conflict_field_named × sync_field_quantity,
	// naming the item, Anna via B's roster cache, and A's committed value.
	await expect(
		pageB.getByText('„Milch“: Anna hatte die Menge schon auf „2 Liter“ gesetzt')
	).toBeVisible();
	// B's optimistic '5 Liter' is gone; the row shows the winner.
	await expect(milchB.getByRole('button', { name: 'Menge bearbeiten' })).toContainText('2 Liter');

	// --- round 2: edit vs remove (`deleted_conflict`) — Butter's note vs Butter itself ---
	await ctxB.setOffline(true);
	await expect(pageB.getByTestId('sync-line')).toContainText('Offline');

	// [D-119]: the row's name is the door to the detail sheet's fuller edits.
	await itemRow(pageB, 'Butter').locator('.row-name').click();
	const detailB = pageB.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await detailB.locator('#detail-note').fill('Bio');
	await detailB.locator('#detail-note').blur();
	await detailB.getByRole('button', { name: 'Schließen' }).click();

	// A removes the item entirely, online, while B's edit is still queued.
	await itemRow(pageA, 'Butter').locator('.row-name').click();
	const detailA = pageA.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await Promise.all([
		pageA.waitForResponse((r) => r.url().includes('/api/sync/push') && r.ok()),
		detailA.getByRole('button', { name: 'Butter von der Liste entfernen' }).click()
	]);

	await Promise.all([
		pageB.waitForResponse((r) => r.url().includes('/api/sync/push') && r.ok()),
		ctxB.setOffline(false)
	]);
	await expect(
		pageB.getByText('„Butter“ wurde entfernt, während du es bearbeitet hast')
	).toBeVisible();
	await expect(itemRow(pageB, 'Butter')).toHaveCount(0);

	// --- round 3: same item added on both (`merged`, §8.3 step 2) — a new name ---
	await ctxB.setOffline(true);
	await expect(pageB.getByTestId('sync-line')).toContainText('Offline');

	await addItemByTyping(pageB, 'Käse');
	const kaeseB = itemRow(pageB, 'Käse');
	await kaeseB.getByRole('button', { name: 'Menge hinzufügen' }).click();
	await kaeseB.getByRole('textbox', { name: 'Menge bearbeiten' }).fill('3 Stück');
	await kaeseB.getByRole('textbox', { name: 'Menge bearbeiten' }).press('Enter');

	// A adds the same name online, with a different quantity, and it settles
	// before B ever pushes — so A's create is the one the server already holds.
	// Waited for by the push that CARRIES '1 Kilo': the create drains on its own
	// ~500ms after the add, and when that push is still in flight at the Enter,
	// any-push resolves on the create's answer while the quantity waits for the
	// next drain — B then merges into a row with no quantity yet, and the
	// notice quotes an empty one.
	await addItemByTyping(pageA, 'Käse');
	const kaeseA = itemRow(pageA, 'Käse');
	await kaeseA.getByRole('button', { name: 'Menge hinzufügen' }).click();
	await kaeseA.getByRole('textbox', { name: 'Menge bearbeiten' }).fill('1 Kilo');
	await Promise.all([
		pageA.waitForResponse(
			(r) =>
				r.url().includes('/api/sync/push') &&
				r.ok() &&
				(r.request().postData() ?? '').includes('"quantity":"1 Kilo"')
		),
		kaeseA.getByRole('textbox', { name: 'Menge bearbeiten' }).press('Enter')
	]);

	await Promise.all([
		pageB.waitForResponse((r) => r.url().includes('/api/sync/push') && r.ok()),
		ctxB.setOffline(false)
	]);
	await expect(
		pageB.getByText('„Käse“ war schon auf der Liste. Die Menge „1 Kilo“ von Anna wurde behalten.')
	).toBeVisible();
	// Exactly one Käse row, carrying A's (the survivor's) quantity — B's
	// duplicate optimistic row is gone, not merely hidden.
	await expect(pageB.locator('[data-testid="row"]', { hasText: 'Käse' })).toHaveCount(1);
	await expect(kaeseB.getByRole('button', { name: 'Menge bearbeiten' })).toContainText('1 Kilo');

	await ctxA.close();
	await ctxB.close();
});

// §8.6 / §7.3 [D-138]: a list deleted while this device was offline. One
// account, two devices. Device 2 is offline with a queued edit when device 1
// leaves the list as its last member, which deletes the list server-side.
//
// Device 2's queued op comes back denied/not_member, never `gone` — the server
// checks membership before the list's existence — so the only thing that
// learns the list is gone is a full cycle's membership set (carried on the
// digest, [D-28]). So the denial runs a full cycle at once — not the generic
// "change could not be synced" toast and a silent purge up to a minute later —
// and the purge names the list, in copy that is neutral about how the
// membership ended.
test('a list deleted while this device was offline: named notice, list gone', async ({
	browser
}) => {
	const ctx1 = await browser.newContext();
	const page1 = await ctx1.newPage();
	await registerAccount(page1, 'Anna');
	await createList(page1, 'Familienliste');
	await openListView(page1);
	await addItemByTyping(page1, 'Milch');
	await expect(itemRow(page1, 'Milch')).toBeVisible();

	const device2 = await openSameAccountDevice(browser, page1);
	const page2 = device2.page;
	await page2.getByRole('link', { name: 'Familienliste öffnen' }).click();
	await openListView(page2);
	// Deterministic convergence for the fresh Dexie mirror (house pattern, see
	// offline-shop.spec.ts / item-edit.spec.ts).
	await page2.reload();
	await openListView(page2);
	await expect(itemRow(page2, 'Milch')).toBeVisible({ timeout: 15_000 });

	// Device 2 goes offline and edits locally — this is what queues an op that,
	// on reconnect, has to ask the server about a list that no longer exists.
	await device2.context.setOffline(true);
	await expect(page2.getByTestId('sync-line')).toContainText('Offline');
	await itemRow(page2, 'Milch').locator('.row-name').click();
	const detail2 = page2.getByRole('dialog', { name: 'Artikel bearbeiten' });
	await detail2.locator('#detail-note').fill('für Kaffee');
	await detail2.locator('#detail-note').blur();
	await detail2.getByRole('button', { name: 'Schließen' }).click();

	// Device 1 leaves — this is the ONLY membership on this list (both devices
	// are the same account), so §7.3 deletes the list server-side.
	await page1.goto('/');
	await page1.getByRole('button', { name: 'Aktionen für Familienliste' }).click();
	await page1.getByRole('menuitem', { name: 'Liste verlassen' }).click();
	await page1.getByRole('alertdialog').getByRole('button', { name: 'Liste verlassen' }).click();
	// Its card goes with the list.
	await expect(page1.getByRole('link', { name: /Familienliste/ })).toHaveCount(0, {
		timeout: 15_000
	});

	// Device 2 reconnects: the denial is not reported as a failed change, the
	// full cycle it triggers purges the list, and the purge names it.
	await device2.context.setOffline(false);
	await expect(page2.getByText('„Familienliste“ ist nicht mehr in deinen Listen.')).toBeVisible({
		timeout: 15_000
	});
	await expect(
		page2.getByText(
			'Eine Änderung konnte nicht synchronisiert werden und wurde rückgängig gemacht.'
		)
	).toHaveCount(0);
	await page2.goto('/');
	await expect(page2.getByRole('link', { name: 'Familienliste öffnen' })).toHaveCount(0);

	// The device that left knows why; it gets no notice.
	await expect(page1.getByText(/ist nicht mehr in deinen Listen/)).toHaveCount(0);

	await ctx1.close();
	await device2.context.close();
});
