import { expect, test } from '../tests/fixtures';
import {
	addItemByTyping,
	createList,
	expectSynced,
	expireStoredToken,
	itemRow,
	openListView,
	readAuthBlob
} from '../tests/helpers';
import { home, loginAtDex, ownClientIpPerExchange, signInWithDex, signOut } from './dex';

// [D-76] An instance with SHOPPINGLIST_PASSKEYS=off (oidc.config.ts's second
// app server): OIDC is the only login, and nothing passkey-shaped is offered —
// not on the auth screen, not in settings, not on the server.
ownClientIpPerExchange(1);

test('an OIDC-only instance offers the provider and nothing passkey-shaped', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Weiter mit Dex' })).toBeVisible();
	await expect(page.getByText(/Beim ersten Mal wird dein Konto erstellt/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Mit Passkey anmelden' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Konto erstellen' })).toHaveCount(0);

	// The routes are not there at all, not merely hidden.
	const begin = await page.request.post('/api/passkey/login/begin', { data: {} });
	expect(begin.status()).toBe(404);

	await signInWithDex(page, 'Finn');
	await expect(page.getByText('Willkommen!')).toBeVisible();
	const listName = `Markt ${Date.now().toString(36)}`;
	await createList(page, listName);

	await page.goto('/settings');
	await expect(page.getByText('Verbunden mit Dex als finn@example.com.')).toBeVisible();
	// The OIDC login is this instance's only way in: nothing to remove it for ([D-76]).
	await expect(page.getByRole('button', { name: 'Anmeldung entfernen' })).toHaveCount(0);
	await expect(page.getByText('Passkeys', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Passkey hinzufügen' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Mit Dex verbinden/ })).toHaveCount(0);

	await signOut(page);
	await signInWithDex(page, 'Finn');
	await home(page);
	await expect(page.getByText(listName)).toBeVisible();
});

// [D-76]: the sync chip signs back in with the login the device last used —
// not unconditionally with a passkey, which an account without one cannot
// complete (on this instance, every account) — and the change made while the
// session was expired still syncs.
test('an expired OIDC session re-authenticates from the sync chip and drains its outbox', async ({
	page
}) => {
	await page.goto('/');
	await signInWithDex(page, 'Gina');
	await expect(page.getByText('Willkommen!')).toBeVisible();
	await createList(page, 'Wochenmarkt');
	await openListView(page);

	await expireStoredToken(page);
	await page.reload();
	await openListView(page);
	const chip = page.getByRole('button', { name: /Sitzung abgelaufen/ });
	await expect(chip).toBeVisible();

	// Queued, not synced: there is no valid token to push with.
	await addItemByTyping(page, 'Radieschen');
	await expect(itemRow(page, 'Radieschen')).toBeVisible();

	const popup = page.waitForEvent('popup');
	await chip.click();
	await loginAtDex(await popup, 'Gina');

	await expectSynced(page);
	await expect(itemRow(page, 'Radieschen')).toBeVisible();
});

// [D-309]: deleting wants a sign-in from moments ago, and an account without a
// passkey gives it through the provider. Giving up on the popup keeps the
// account; signing in there deletes it.
test('an OIDC-only account signs in with the provider again to delete itself', async ({ page }) => {
	await page.goto('/');
	await signInWithDex(page, 'Ida');
	await createList(page, 'Wochenende');

	await page.goto('/settings');
	await page.getByRole('button', { name: 'Konto endgültig löschen' }).click();
	const dialog = page.getByRole('alertdialog');
	let popup = page.waitForEvent('popup');
	await dialog.getByRole('button', { name: 'Konto löschen' }).click();
	// The page cannot see the popup close, so Cancel gives up on it.
	await dialog.getByRole('button', { name: 'Abbrechen' }).click();
	await (await popup).close();
	await home(page);
	await expect(page.getByText('Wochenende')).toBeVisible();
	// The list above is the local mirror's: the server is asked whether the
	// account is still there.
	const { token } = JSON.parse(await readAuthBlob(page)) as { token: string };
	const refreshed = await page.request.post('/api/collections/accounts/auth-refresh', {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(refreshed.status(), 'the account survives a cancelled delete').toBe(200);

	await page.goto('/settings');
	await page.getByRole('button', { name: 'Konto endgültig löschen' }).click();
	popup = page.waitForEvent('popup');
	await dialog.getByRole('button', { name: 'Konto löschen' }).click();
	await loginAtDex(await popup, 'Ida');
	await expect(page.getByRole('button', { name: 'Weiter mit Dex' })).toBeVisible({
		timeout: 15_000
	});

	// The provider's next sign-in starts over: the account and its list went.
	await signInWithDex(page, 'Ida');
	await expect(page.getByText('Willkommen!')).toBeVisible();
});
