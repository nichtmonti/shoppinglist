import { expect, test, type Page } from './fixtures';
import {
	addItemByTyping,
	createList,
	itemRow,
	openListView,
	registerAccount,
	shareListWith
} from './helpers';

// The two irreversible account-level actions, against the real binary. Both
// are server-side cascades whose blast radius is a whole list: §7.2/§7.3
// (leaving; last one out deletes the list) and §4.5 (deleting an account:
// cascade the solo lists, leave the shared ones intact). Unit and component
// tests cover the wiring; only this layer can show that the cascade actually
// spared what it was supposed to spare.

/** Opens /settings directly — the ⚙︎ link only lives on the home screen. */
async function openSettings(page: Page): Promise<void> {
	await page.goto('/settings');
	// The level-1 heading is the sr-only page title (P5); level 2 is the visible one.
	await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
}

test('leave a shared list: the leaver loses it locally, the other member keeps it', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Wochenshop');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Milch');
	await expect(itemRow(pageA, 'Milch')).toBeVisible();

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible({ timeout: 15_000 });

	// B leaves from the list's own ⋮ (two-step in-UI confirm, §7.2 [D-270]).
	await pageB.getByTestId('list-menu').click();
	await pageB.getByRole('button', { name: 'Liste verlassen' }).click();
	await pageB.getByRole('alertdialog').getByRole('button', { name: 'Liste verlassen' }).click();

	// B lands on the home without it, and it stays gone across a reload —
	// proving the server-side membership delete, not just the local §8.6 purge.
	await expect(pageB).toHaveURL(/\/$/, { timeout: 15_000 });
	await pageB.goto('/');
	await expect(pageB.getByRole('link', { name: 'Wochenshop öffnen' })).toHaveCount(0);

	// A is not the last one out, so §7.3 must NOT have cascaded the list away.
	await pageA.reload();
	await openListView(pageA);
	await expect(itemRow(pageA, 'Milch')).toBeVisible({ timeout: 15_000 });

	await ctxA.close();
	await ctxB.close();
});

test('delete account: solo list cascades, shared list survives for the other member', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	const passkeyA = await registerAccount(pageA, 'Anna');

	// A solo list, which §4.5 must cascade-delete...
	await createList(pageA, 'Nur ich');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Zahnpasta');
	await expect(itemRow(pageA, 'Zahnpasta')).toBeVisible();

	// ...and a shared one, which must survive for B with its items.
	await pageA.goto('/');
	await createList(pageA, 'Familie');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Milch');
	await expect(itemRow(pageA, 'Milch')).toBeVisible();

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await shareListWith(pageA, pageB);
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible({ timeout: 15_000 });

	await openSettings(pageA);
	await pageA.getByRole('button', { name: 'Konto endgültig löschen' }).click();
	// The confirmation states the split before the user commits to it.
	// One shared, one solo: each half in its own sentence, singular ([D-214]).
	await expect(
		pageA.getByText(
			'Deine geteilte Liste bleibt bei ihren Mitgliedern. Deine eigene Liste wird endgültig gelöscht.'
		)
	).toBeVisible();
	// Deleting asks for the passkey first ([D-309]): a dismissed prompt
	// deletes nothing and says so in the open confirmation.
	await passkeyA.setUserVerified(false);
	await pageA.getByRole('button', { name: 'Konto löschen' }).click();
	await expect(
		pageA.getByText('Anmeldung abgebrochen. Dein Konto wurde nicht gelöscht.')
	).toBeVisible();
	await passkeyA.setUserVerified(true);
	await pageA.getByRole('button', { name: 'Konto löschen' }).click();

	// The session ends: the app shell swaps to the auth screen on its own
	// (authState.isValid flips) — no navigation in the delete path.
	await expect(pageA.getByLabel('Spitzname', { exact: true })).toBeVisible({ timeout: 15_000 });

	// B still has the shared list, its items, and can still work in it — the
	// §7.3 cascade must not have fired for a list that still has a member.
	await pageB.reload();
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible({ timeout: 15_000 });
	await addItemByTyping(pageB, 'Butter');
	await expect(itemRow(pageB, 'Butter')).toBeVisible();
	await expect(pageB.getByText('Alle Änderungen synchronisiert')).toBeVisible({ timeout: 15_000 });

	await ctxA.close();
	await ctxB.close();
});
