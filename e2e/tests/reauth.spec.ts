import { expect, test } from './fixtures';
import {
	addItemByTyping,
	createList,
	expectSynced,
	expireStoredToken,
	itemRow,
	nicknameField,
	openListView,
	registerAccount
} from './helpers';

// §5.8: a one-tap re-auth prompt on an expired token, with the outbox
// preserved. The app-shell auth gate (+layout.svelte) keys off "has this
// device ever signed in", not `authState.isValid` (is the JWT CURRENTLY
// unexpired): keying off validity would replace the whole app — including the
// list view hosting SyncBanner's one-tap re-auth — with the full sign-in
// screen the moment a token expired, leaving no way to reach the re-auth tap.
//
// (The expired token is forced by helpers.ts's expireStoredToken.)

test(
	'expired token: the app stays usable offline-style, the one-tap re-auth is reachable, and the preserved outbox drains on re-auth',
	{ tag: '@chromium' },
	async ({ page }) => {
		await registerAccount(page, 'Anna');
		await createList(page, 'Wochenshop');
		await openListView(page);

		await expireStoredToken(page);
		await page.reload();
		await openListView(page);

		// Still the real app — not bounced to the sign-in screen — and the one-tap
		// re-auth is reachable right where §12.1 puts it, inside the list view.
		await expect(page.getByRole('button', { name: /Sitzung abgelaufen/ })).toBeVisible();
		await expect(nicknameField(page)).toHaveCount(0);

		// Local read/write is unaffected by the expired token (§5.8) — this queues
		// into the outbox rather than syncing (no valid token to push with).
		await addItemByTyping(page, 'Käse');
		await expect(itemRow(page, 'Käse')).toBeVisible();

		// One tap re-authenticates (the virtual authenticator's resident key from
		// registerAccount is still available for this origin) …
		await page.getByRole('button', { name: /Sitzung abgelaufen/ }).click();

		// … and the preserved outbox drains immediately, with no re-adding needed.
		await expectSynced(page);
		await expect(itemRow(page, 'Käse')).toBeVisible();
	}
);

// [D-130]: the same requirement, one screen over. The sync chip is the ONE
// control that clears an expired session, so it mounts in all three app bars —
// a token that expires while the user is on the home or in settings must not
// leave them without a way back. Off a list its count is the whole device's
// outbox rather than one list's.
test(
	'expired token: the re-auth tap is reachable from the home and from settings, not only inside a list',
	{ tag: '@chromium' },
	async ({ page }) => {
		await registerAccount(page, 'Anna');
		await createList(page, 'Wochenshop');

		await expireStoredToken(page);

		// Navigate rather than reload: createList leaves the browser ON the new list,
		// which is the one screen that always had the chip. `goto` also re-reads the
		// now-expired token out of IndexedDB, so no separate reload is needed.
		// The home — where a user lands, and where there is no list app bar.
		await page.goto('/');
		await expect(page.getByRole('button', { name: /Sitzung abgelaufen/ })).toBeVisible();

		// Settings — where a user goes when their account looks wrong.
		await page.goto('/settings');
		await expect(page.getByRole('button', { name: /Sitzung abgelaufen/ })).toBeVisible();

		// And it works from there: one tap, and the session is valid again.
		await page.getByRole('button', { name: /Sitzung abgelaufen/ }).click();
		await expectSynced(page);
	}
);
