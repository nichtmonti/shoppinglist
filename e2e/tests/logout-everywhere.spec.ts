import { expect, test, type Page } from './fixtures';
import {
	addItemByTyping,
	createList,
	disableConditionalMediation,
	itemRow,
	openListView,
	readAuthBlob,
	registerAccount,
	storeCount,
	tapSyncConsole,
	writeAuthBlob
} from './helpers';

// §5.6 / [D-04] "log out everywhere" across TWO devices, against the real
// binary. account/rotate_test.go already proves the token layer (mint, rotate,
// same token now rejected); what only this layer can show is the product path:
// a SECOND device holding a perfectly good, unexpired token for the same
// account stops being able to reach the server the moment the first device
// rotates — and does not quietly appear to keep working.
//
// The second device is a second browser context seeded with the first's
// persisted `{token, record}` blob (IndexedDB `einkaufsliste`/`kv`/`pb_auth`,
// #lib/idb.ts + #lib/pb.ts — the PocketBase AsyncAuthStore serialization).
// That is exactly the state a real second device is in after its own passkey
// login: same account, its own independently-issued token. Copying the blob
// rather than running a second WebAuthn ceremony keeps the spec to one virtual
// authenticator; the token is what rotation acts on either way.

/**
 * Does the server still accept whatever token this device holds? auth-refresh
 * is the one endpoint that answers exactly that: a collection *list* endpoint
 * would not — PocketBase applies a rule referencing `@request.auth.id` as a
 * filter, so an unusable token comes back as 200-with-nothing, not 401.
 */
async function authedReadStatus(page: Page): Promise<number> {
	const { token } = JSON.parse(await readAuthBlob(page)) as { token: string };
	return page.evaluate(async (bearer) => {
		const resp = await fetch('/api/collections/accounts/auth-refresh', {
			method: 'POST',
			headers: { Authorization: `Bearer ${bearer}` }
		});
		return resp.status;
	}, token);
}

test('log out everywhere: the other device’s still-unexpired token stops working', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	tapSyncConsole(pageA, 'device-A');
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Wochenshop');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Milch');
	await expect(pageA.getByText('Alle Änderungen synchronisiert')).toBeVisible();

	// Second device: same account, signed in, syncing from the server on its own.
	const blob = await readAuthBlob(pageA);
	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	tapSyncConsole(pageB, 'device-B');

	await pageB.goto('/');
	await writeAuthBlob(pageB, blob);
	await pageB.reload();
	await pageB.getByRole('link', { name: 'Wochenshop öffnen' }).click();
	await openListView(pageB);
	// B is a fresh device: Milch exists locally only after B's first sync pull.
	// Reload to force that pull deterministically (the convergence pattern from
	// offline-shop and account-lifecycle) — on a contended box the initial pull
	// can otherwise outrun the assertion window.
	await pageB.reload();
	await openListView(pageB);
	await expect(itemRow(pageB, 'Milch')).toBeVisible();
	expect(await authedReadStatus(pageB)).toBe(200);

	// A rotates the account's token key from settings.
	await pageA.goto('/settings');
	await expect(pageA.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
	// For this document only: the virtual authenticator answers the auth
	// screen's passkey autofill on its own, and could sign A back in between
	// two polls for the screen below. The reload further down brings it back.
	await disableConditionalMediation(pageA);
	await pageA.getByRole('button', { name: 'Überall abmelden' }).click();
	// Confirmed first ([D-214]).
	await pageA.getByRole('alertdialog').getByRole('button', { name: 'Überall abmelden' }).click();

	// The caller's own token dies with the rest: the shell swaps to the auth
	// screen on its own (authState.isValid flips), no navigation involved.
	await expect(pageA.getByLabel('Spitzname', { exact: true })).toBeVisible();

	// The other device is now rejected by the server, even though its JWT has
	// not expired and it never touched the app.
	expect(await authedReadStatus(pageB)).toBe(401);

	// And the rejection is real at the product level, not just at the API. B's
	// session is still open (nothing pushed the news to it), so its write lands
	// locally — but it cannot reach the server and stays pending in the outbox
	// instead of settling to "all synced".
	await addItemByTyping(pageB, 'Butter');
	await expect(itemRow(pageB, 'Butter')).toBeVisible();
	await expect(pageB.getByText(/nicht synchronisiert/)).toBeVisible();
	await expect(pageB.getByText('Alle Änderungen synchronisiert')).toHaveCount(0);

	// Relaunching B must preserve its offline mirror. The membership set rides
	// on the digest route behind RequireAuth ([D-28]), so the revoked token is
	// a 401 there — never an empty set the vanished-list purge would act on —
	// and the cached membership, its items and the pending Butter write survive.
	await pageB.reload();
	await expect(itemRow(pageB, 'Milch')).toBeVisible();
	await expect(itemRow(pageB, 'Butter')).toBeVisible();
	expect(await storeCount(pageB, 'memberships')).toBe(1);
	expect(await storeCount(pageB, 'items')).toBe(2);
	expect(await storeCount(pageB, 'pending_ops')).toBe(1);

	// A's account itself is intact, and the re-auth needs no button press
	// ([D-69]): the auth screen starts a conditional-mediation ceremony on
	// mount, and Chromium's virtual authenticator auto-approves conditional
	// requests, so A is signed back in with its resident passkey by the time we
	// look (rotation revokes tokens, not credentials, §5.6). Waiting for the
	// signed-in surface is the assertion; a real user would pick the passkey
	// from the autofill dropdown instead.
	// A sign-out lands on the home ([D-185]), so that is where A re-renders;
	// the reload gives the auth screen its passkey autofill back.
	await expect(pageA).toHaveURL(/\/$/);
	await pageA.reload();
	await expect(pageA.getByRole('link', { name: 'Wochenshop öffnen' })).toBeVisible({
		timeout: 15_000
	});

	// B is still out: re-authenticating on A issues A a token under the NEW key
	// and does nothing for the device that was signed out.
	expect(await authedReadStatus(pageB)).toBe(401);

	await ctxA.close();
	await ctxB.close();
});
