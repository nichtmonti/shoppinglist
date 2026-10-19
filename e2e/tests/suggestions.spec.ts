import { expect, test } from './fixtures';
import { createList, openListView, openSameAccountDevice, registerAccount } from './helpers';

// §6.11/§9 E2E: suggestion suppression ("Nicht mehr vorschlagen") is an
// ACCOUNT-bound preference, not a device-local one — it has to survive on a
// second device, not just in this browser's Dexie.
//
// The write is not in the outbox: prefs.ts keeps each unconfirmed change in
// `suppressed_pending` and merges it into the account record when it can
// ([D-137]), so an offline suppression is not overwritten by the account
// record on the next app start — the last section drives exactly that case.
// `page.on('response')` below logs every account write, so a rejection is
// visible in the run's own output.
test('suggestion suppression is account-bound: suppress on A, offered nowhere, restore, offered again', async ({
	browser
}) => {
	const page = await (await browser.newContext()).newPage();
	// Surfaces the accounts-record PATCH flushSuppressed makes (§6.11 is
	// explicit this never goes through the outbox/sync/push path).
	page.on('response', (resp) => {
		if (
			/\/api\/collections\/accounts\/records\//.test(resp.url()) &&
			resp.request().method() !== 'GET'
		) {
			console.log(`[suppression PATCH] ${resp.status()} ${resp.url()}`);
		}
	});

	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);

	// The seeded item_dictionary has both "Butter" and "Buttermilch" — two
	// distinct entries sharing the "But" prefix, so suppressing one is
	// distinguishable from the mirror simply not having arrived yet.
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill('But');
	const butterOption = page.locator('[data-ta-name="Butter"]');
	const buttermilchOption = page.locator('[data-ta-name="Buttermilch"]');
	// Readiness proof, same pattern as dictionary-mirror.spec.ts/auto-category.spec.ts.
	await expect(butterOption).toBeVisible({ timeout: 15_000 });
	await expect(buttermilchOption).toBeVisible();

	// "Nicht mehr vorschlagen" — the ✕ badge on the suggestion row. It is
	// aria-hidden (the row itself is the accessible option), so target it by
	// its title rather than a role.
	const patchResponse = page.waitForResponse(
		(resp) =>
			/\/api\/collections\/accounts\/records\//.test(resp.url()) &&
			resp.request().method() === 'PATCH'
	);
	await butterOption.locator('.ta-suppress').click();
	const suppressResp = await patchResponse;
	console.log(`[suppress] PATCH -> ${suppressResp.status()}`);
	expect(suppressResp.ok()).toBeTruthy();

	await expect(page.getByText('„Butter“ wird nicht mehr vorgeschlagen')).toBeVisible();
	// It disappears from THIS device's typeahead immediately (the local mirror
	// is written first, for instant offline effect).
	await expect(butterOption).toHaveCount(0);
	await expect(buttermilchOption).toBeVisible();
	await input.fill('');

	// --- a fresh same-account device: proof the suppression reached the server,
	// not just this browser's Dexie (a reload of A alone would prove nothing).
	// The copied auth blob carries A's cached account record, but boot runs
	// refreshOnStart (auth-refresh) BEFORE refreshSuppressedMirror, so B's
	// mirror is filled from the server's record, not from that copy ---
	const deviceB = await openSameAccountDevice(browser, page);
	const pageB = deviceB.page;
	await pageB.getByRole('link', { name: 'Wochenshop öffnen' }).click();
	await openListView(pageB);

	const inputB = pageB.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await inputB.fill('But');
	const butterOptionB = pageB.locator('[data-ta-name="Butter"]');
	const buttermilchOptionB = pageB.locator('[data-ta-name="Buttermilch"]');
	// The sibling suggestion proves B's dictionary mirror is actually up —
	// so "Butter" not being offered is the suppression, not a race.
	await expect(buttermilchOptionB).toBeVisible({ timeout: 15_000 });
	await expect(butterOptionB).toHaveCount(0);
	await inputB.fill('');

	// --- restore it from the settings screen's "review and restore" list ---
	await page.goto('/settings');
	await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
	// Its row opens the sheet, which shows the stored NORMALIZED form (§6.11,
	// [D-44]).
	await page.getByRole('button', { name: /^Ausgeblendete Vorschläge/ }).click();
	const hiddenRow = page.getByText('butter', { exact: true });
	await expect(hiddenRow).toBeVisible();

	const unsuppressResponse = page.waitForResponse(
		(resp) =>
			/\/api\/collections\/accounts\/records\//.test(resp.url()) &&
			resp.request().method() === 'PATCH'
	);
	await page.getByRole('button', { name: 'Wieder vorschlagen' }).click();
	const restoreResp = await unsuppressResponse;
	console.log(`[unsuppress] PATCH -> ${restoreResp.status()}`);
	expect(restoreResp.ok()).toBeTruthy();
	// The last one restored closes the sheet, and the row says so.
	await expect(hiddenRow).toBeHidden();
	await expect(page.getByText('keine', { exact: true })).toBeVisible();

	// --- back on B: reload picks the restored server state up again ---
	await pageB.reload();
	await openListView(pageB);
	await inputB.fill('But');
	await expect(pageB.locator('[data-ta-name="Butter"]')).toBeVisible({ timeout: 15_000 });
	await inputB.fill('');

	// --- offline: suppressing works from the local mirror, and the change is
	// delivered once the connection is back ([D-137]) instead of the suggestion
	// quietly coming back on the next app start. ---
	await page.goto('/');
	await page.getByRole('link', { name: 'Wochenshop öffnen' }).click();
	await openListView(page);
	await page.context().setOffline(true);
	await input.fill('But');
	await buttermilchOption.locator('.ta-suppress').click();
	await expect(buttermilchOption).toHaveCount(0);
	await input.fill('');

	const delivered = page.waitForResponse(
		(resp) =>
			/\/api\/collections\/accounts\/records\//.test(resp.url()) &&
			resp.request().method() === 'PATCH',
		{ timeout: 15_000 }
	);
	await page.context().setOffline(false);
	expect((await delivered).ok()).toBeTruthy();

	// An app start after reconnecting keeps it hidden here, and a device that
	// only knows the server's copy does not offer it either.
	await page.reload();
	await openListView(page);
	await input.fill('But');
	await expect(butterOption).toBeVisible({ timeout: 15_000 });
	await expect(buttermilchOption).toHaveCount(0);

	await pageB.reload();
	await openListView(pageB);
	await inputB.fill('But');
	await expect(butterOptionB).toBeVisible({ timeout: 15_000 });
	await expect(buttermilchOptionB).toHaveCount(0);

	await deviceB.context.close();
	await page.context().close();
});
