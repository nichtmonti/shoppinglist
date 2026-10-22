import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures';
import {
	addItemByTyping,
	appearsAfter,
	createList,
	expectSynced,
	itemRow,
	openListView,
	openSameAccountDevice,
	registerAccount
} from './helpers';

// §7.5/§7.6/§9.3 + the backup/clone routes ([D-72]): the home's ⋯ menu
// and the in-list ⋮ sheet both drive server routes that
// only this spec drives rename/duplicate/export/import through end to end
// — component tests mock pb, and the integration project round-trips the
// backup envelope via the route directly, never through the browser's file
// handling. One account, one list: rename (a direct write of the lists row, [D-08]),
// duplicate (POST .../clone), export (Blob + <a download>, no server
// round-trip [D-72]) and import (POST /api/lists/import) chained on device A,
// then a fresh same-account device proves every one of the three new lists —
// renamed original, clone, import — actually reached the server.
test('rename, duplicate, export and import a list, and a fresh device sees all three', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Rena');
	await createList(pageA, 'Wocheneinkauf');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Milch');
	await addItemByTyping(pageA, 'Butter');
	await expectSynced(pageA);

	// ---- 1. rename: the list's one name, every member's ([D-08]; list-name.spec
	// shows a co-member receiving it). Driven from the in-list ⋮
	// ⋮ sheet, which carries the same rename action as the
	// home card's ⋯ menu.
	const renamedName = 'Wocheneinkauf Samstag';
	await pageA.getByTestId('list-menu').click();
	await pageA.getByRole('button', { name: 'Umbenennen', exact: true }).click();
	const renameDialog = pageA.getByRole('dialog', { name: 'Umbenennen' });
	await renameDialog.getByLabel('Name').fill(renamedName);
	await renameDialog.getByRole('button', { name: 'Speichern' }).click();
	// The ▾ quick-switcher trigger carries the list's name — the same
	// element helpers.createList() asserts against after creating a list.
	await expect(pageA.getByRole('button', { name: renamedName, exact: true })).toBeVisible();

	// ---- 2. duplicate ("Duplizieren"): [D-72] POST /api/lists/{id}/clone,
	// a transactional server route that copies items + categories into a fresh
	// list. Back to the home for the card's ⋯ menu.
	// The home's card link: the list page's own ⋮ has the same „Aktionen für …"
	// name as the card's, so that one holds before the trip home.
	await appearsAfter(pageA.getByRole('link', { name: `${renamedName} öffnen` }), () =>
		pageA.getByRole('button', { name: 'Zurück' }).click()
	);
	await pageA.getByRole('button', { name: `Aktionen für ${renamedName}` }).click();
	await pageA.getByRole('menuitem', { name: 'Duplizieren' }).click();
	const cloneDialog = pageA.getByRole('dialog', { name: 'Liste duplizieren' });
	// Prefilled with `${name} (Kopie)` — submit as-is.
	await expect(cloneDialog.getByLabel('Name der Kopie')).toHaveValue(`${renamedName} (Kopie)`);
	await cloneDialog.getByRole('button', { name: 'Duplizieren' }).click();
	// A successful clone navigates straight to the new list (like createList).
	await expect(pageA).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	const cloneUrl = pageA.url();
	await openListView(pageA);
	await expect(itemRow(pageA, 'Milch')).toBeVisible();
	await expect(itemRow(pageA, 'Butter')).toBeVisible();

	// ---- 3. export a backup of the ORIGINAL (renamed) list — [D-72], offline-
	// capable: built from the local Dexie mirror, downloaded as a Blob + a
	// temporary `<a download>` click (no navigator.share in Playwright's
	// Chromium, so this path — not the Web Share branch — is the one
	// exercised), caught with page.waitForEvent('download').
	await pageA.getByRole('button', { name: 'Zurück' }).click();
	await expect(
		pageA.getByRole('button', { name: `Aktionen für ${renamedName}`, exact: true })
	).toBeVisible();
	await pageA.getByRole('button', { name: `Aktionen für ${renamedName}`, exact: true }).click();
	const [download] = await Promise.all([
		pageA.waitForEvent('download'),
		pageA.getByRole('menuitem', { name: 'Backup exportieren' }).click()
	]);
	await expect(pageA.getByText('Backup erstellt')).toBeVisible();
	const dlDir = mkdtempSync(path.join(tmpdir(), 'list-backup-'));
	const backupPath = path.join(dlDir, download.suggestedFilename());
	await download.saveAs(backupPath);

	// ---- 4. import that file back in: [D-72] POST /api/lists/import creates a
	// NEW list from the parsed backup — never merges into an existing one. The
	// home footer's "Liste importieren" opens the import screen ([D-254]), whose
	// "Backup-Datei wählen …" clicks a hidden <input type="file">; setInputFiles
	// drives that input directly (it is in the DOM, so there is no native picker
	// to intercept).
	await pageA.getByRole('button', { name: 'Liste importieren' }).click();
	await expect(pageA.getByRole('button', { name: 'Backup-Datei wählen …' })).toBeVisible();
	await pageA.locator('input[type="file"]').setInputFiles(backupPath);
	await expect(pageA).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	const importUrl = pageA.url();
	await openListView(pageA);
	await expect(itemRow(pageA, 'Milch')).toBeVisible();
	await expect(itemRow(pageA, 'Butter')).toBeVisible();

	// Settle + no failure toast before trusting a fresh device.
	await expectSynced(pageA);
	await expect(pageA.getByText(/konnte nicht synchronisiert werden/)).toHaveCount(0);

	// ---- fresh same-account device: proof the writes reached the server, not
	// just this device's own Dexie mirror (a reload of A proves nothing).
	const { context: ctxB, page: pageB } = await openSameAccountDevice(browser, pageA);
	await expect(pageB.getByText('3 Listen')).toBeVisible();
	// The renamed original and the imported copy carry the SAME name
	// (import reuses the backup's `display_name` verbatim, and nothing here
	// overrides it) — only the clone's "(Kopie)" suffix is unique on the home,
	// so identify the other two by their captured list ids instead of by a
	// possibly-ambiguous card label.
	await expect(
		pageB.getByRole('button', { name: `Aktionen für ${renamedName} (Kopie)` })
	).toBeVisible();
	await expect(
		pageB.getByRole('button', { name: `Aktionen für ${renamedName}`, exact: true })
	).toHaveCount(2);

	await pageB.goto(cloneUrl);
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible();
	await expect(itemRow(pageB, 'Butter')).toBeVisible();

	await pageB.goto(importUrl);
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible();
	await expect(itemRow(pageB, 'Butter')).toBeVisible();

	await ctxB.close();
	await ctxA.close();
});
