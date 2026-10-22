import { expect, test } from '../tests/fixtures';
import {
	addVirtualAuthenticator,
	createList,
	expireStoredToken,
	registerAccount
} from '../tests/helpers';
import {
	home,
	loginAtDex,
	nicknameInSettings,
	ownClientIpPerExchange,
	signInWithDex,
	signOut
} from './dex';

ownClientIpPerExchange();

// §5.9 [D-76] OIDC login, its settings link and [D-25]'s "no email" in a
// real browser, against the Dex provider oidc.config.ts starts ([D-154]).
// Each journey signs in as its own Dex user, through Dex's own login form.

test('OIDC sign-in creates an account, and the same identity signs back into it', async ({
	page
}) => {
	await page.goto('/');
	await signInWithDex(page, 'Anna');
	await expect(page.getByText('Willkommen!')).toBeVisible();
	await createList(page, 'Annas Einkauf');
	expect(await nicknameInSettings(page)).toBe('Anna');

	await signOut(page);
	await signInWithDex(page, 'Anna');
	await home(page);
	await expect(page.getByText('Annas Einkauf')).toBeVisible();
});

test('a passkey account links to an OIDC identity and keeps its lists and passkey', async ({
	page
}) => {
	await registerAccount(page, 'Bea');
	await createList(page, 'Baumarkt');

	await page.goto('/settings');
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Mit Dex verbinden' }).click();
	await loginAtDex(await popup, 'Bob');
	// Linked: the entry's precondition is gone ([D-25]: the server says so).
	// The row saying so first, as the entry also reads "Abbrechen" while the
	// link is pending.
	await expect(page.getByText(/^Verbunden mit Dex/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Mit Dex verbinden' })).toHaveCount(0);
	// The login was attached to this account ([D-76]): the session, and the
	// nickname with it, are still the passkey account's.
	expect(await nicknameInSettings(page)).toBe('Bea');

	// The passkey still signs into it...
	await signOut(page);
	await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
	await home(page);
	await expect(page.getByText('Baumarkt')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Mit Dex verbinden' })).toHaveCount(0);

	// ...and so does the provider.
	await signOut(page);
	await signInWithDex(page, 'Bob');
	await home(page);
	await expect(page.getByText('Baumarkt')).toBeVisible();
	expect(await nicknameInSettings(page)).toBe('Bea');
});

// [D-76]: an OIDC identity whose account already has lists is not attached —
// that would delete an account in use. The link is refused with a message,
// and both accounts stay as they were.
test('linking an OIDC identity that already has its own lists is refused', async ({ page }) => {
	await page.goto('/');
	await signInWithDex(page, 'Jana');
	await createList(page, 'Janas Liste');
	await signOut(page);

	await registerAccount(page, 'Jo');
	await createList(page, 'Jos Liste');
	await page.goto('/settings');
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Mit Dex verbinden' }).click();
	await loginAtDex(await popup, 'Jana');
	await expect(page.getByText(/gehört schon zu einem anderen Konto/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Mit Dex verbinden' })).toBeVisible();
	expect(await nicknameInSettings(page)).toBe('Jo');
	await home(page);
	await expect(page.getByText('Jos Liste')).toBeVisible();

	await signOut(page);
	await signInWithDex(page, 'Jana');
	await home(page);
	await expect(page.getByText('Janas Liste')).toBeVisible();
	await expect(page.getByText('Jos Liste')).toHaveCount(0);
});

// The journey as a person takes it: a passkey account that later links its
// OIDC identity signs in with the provider from then on and finds what it had.
test('a linked passkey account signs back in with OIDC and finds its list', async ({ page }) => {
	const listName = `Vorrat ${Date.now().toString(36)}`;

	await registerAccount(page, 'Emilia');
	await signOut(page);
	await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
	await home(page);
	await createList(page, listName);

	await page.goto('/settings');
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Mit Dex verbinden' }).click();
	await loginAtDex(await popup, 'Emil');
	await expect(page.getByText('Verbunden mit Dex als emil@example.com.')).toBeVisible();

	await signOut(page);
	await signInWithDex(page, 'Emil');
	await home(page);
	await expect(page.getByText(listName)).toBeVisible();
});

test('an OIDC account adds a passkey, signs in with it, and may remove it again', async ({
	page
}) => {
	await page.goto('/');
	await signInWithDex(page, 'Cleo');
	await expect(page.getByText('Willkommen!')).toBeVisible();

	await addVirtualAuthenticator(page);
	await page.goto('/settings');
	await page.getByRole('button', { name: 'Passkey hinzufügen' }).click();
	await page.getByLabel('Name für den neuen Passkey').fill('Laptop');
	await page.getByRole('dialog').getByRole('button', { name: 'Passkey hinzufügen' }).click();
	await expect(page.getByTestId('passkey-row')).toHaveCount(1, { timeout: 15_000 });

	await signOut(page);
	await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
	await home(page);
	expect(await nicknameInSettings(page)).toBe('Cleo');

	// Its only passkey, but not its only login ([D-25]): the guard lets it go.
	await page.getByRole('button', { name: 'Laptop', exact: true }).click();
	await page.getByRole('button', { name: 'Passkey entfernen' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen' }).click();
	await expect(page.getByTestId('passkey-row')).toHaveCount(0);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('signing in with OIDC never lands on an existing passkey account', async ({ page }) => {
	await registerAccount(page, 'Dora');
	await createList(page, 'Doras Liste');

	await signOut(page);
	await signInWithDex(page, 'Dora');
	// A new, empty account — an OIDC login reaches an existing account only
	// through the explicit link ([D-76]).
	await home(page);
	await expect(page.getByText('Willkommen!')).toBeVisible();
	await expect(page.getByText('Doras Liste')).toHaveCount(0);
});

test('a sign-in whose popup was closed can be cancelled', async ({ page }) => {
	// A real browser always has an authenticator for the passkey autofill;
	// without one, Chromium fails that background ceremony with an alert of
	// its own the moment the popup takes focus.
	await addVirtualAuthenticator(page);
	await page.goto('/');
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Weiter mit Dex' }).click();
	await (await popup).close();

	// The page cannot see the popup go (oidcLogin), so it offers the way out.
	await page.getByRole('button', { name: 'Abbrechen' }).click();
	await expect(page.getByRole('button', { name: 'Weiter mit Dex' })).toBeEnabled();
	await expect(page.getByRole('alert')).toHaveCount(0);

	// And the next attempt still signs in.
	await signInWithDex(page, 'Anna');
	await home(page);
});

// [D-76]: the OIDC login can be removed from settings once the account has a
// passkey. The account and its lists stay; the provider identity no longer
// maps to it, so the next OIDC sign-in creates a separate, empty account.
test('a linked account removes its OIDC login and keeps its lists and passkey', async ({
	page
}) => {
	await registerAccount(page, 'Hanne');
	await createList(page, 'Hannes Vorrat');

	await page.goto('/settings');
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Mit Dex verbinden' }).click();
	await loginAtDex(await popup, 'Hanna');
	// Dex sends no preferred_username, so the identity is the address.
	await expect(page.getByText('Verbunden mit Dex als hanna@example.com.')).toBeVisible();

	await page.getByRole('button', { name: 'Anmeldung entfernen' }).click();
	await expect(page.getByText(/erstellt danach ein neues, leeres Konto/)).toBeVisible();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen' }).click();
	await expect(page.getByRole('button', { name: 'Mit Dex verbinden' })).toBeVisible();
	await expect(page.getByText(/Verbunden mit Dex/)).toHaveCount(0);

	// The provider now opens a new, empty account...
	await signOut(page);
	await signInWithDex(page, 'Hanna');
	await home(page);
	await expect(page.getByText('Willkommen!')).toBeVisible();
	await expect(page.getByText('Hannes Vorrat')).toHaveCount(0);

	// ...and the passkey still opens the one that has the list.
	await signOut(page);
	await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
	await home(page);
	await expect(page.getByText('Hannes Vorrat')).toBeVisible();
});

// [D-76]: a re-auth that would land in another account is refused. Here the
// OIDC login was removed while another device still remembered OIDC as how it
// signs in (stood in for by setting this device's memory back): its re-auth
// creates a fresh account for the provider identity, which the app refuses,
// deletes again, and points the user at the passkey — without touching the
// local lists.
test('a re-auth through a removed OIDC login is refused and the passkey takes over', async ({
	page
}) => {
	await registerAccount(page, 'Idalein');
	const listUrl = await createList(page, 'Idas Liste');

	await page.goto('/settings');
	const popup = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Mit Dex verbinden' }).click();
	await loginAtDex(await popup, 'Ida');
	await page.getByRole('button', { name: 'Anmeldung entfernen' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen' }).click();
	await expect(page.getByRole('button', { name: 'Mit Dex verbinden' })).toBeVisible();

	await page.evaluate(() => localStorage.setItem('einkaufsliste-last-login', 'oidc'));
	await expireStoredToken(page);
	await page.goto(listUrl);
	const chip = page.getByRole('button', { name: /Sitzung abgelaufen/ });
	await expect(chip).toBeVisible();

	const reauthPopup = page.waitForEvent('popup');
	await chip.click();
	await loginAtDex(await reauthPopup, 'Ida');
	await expect(
		page.getByText('Deine Dex-Anmeldung ist nicht mehr mit diesem Konto verbunden.', {
			exact: false
		})
	).toBeVisible();
	// Still this account's list, still expired.
	await expect(page.getByRole('button', { name: 'Idas Liste', exact: true })).toBeVisible();
	await expect(chip).toBeVisible();

	// The chip now offers the passkey, which signs back into this account.
	await chip.click();
	await expect(page.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});
	await expect(page.getByRole('button', { name: 'Idas Liste', exact: true })).toBeVisible();
});
