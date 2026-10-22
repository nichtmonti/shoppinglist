import { expect, test } from './fixtures';
import {
	addItemByTyping,
	addVirtualAuthenticator,
	createList,
	inviteLinkFor,
	nicknameField,
	openListView,
	registerAccount
} from './helpers';

// §7, §7.1, §7.4, §7.6 — a new household member arrives, a reset invite link
// stops working, and so does a revoked one.
//
// The existing E2E share coverage (helpers.shareListWith, used by
// account-lifecycle/category-sync) only ever joins with an ALREADY REGISTERED
// account. That skips the actual §7.6 visitor path: someone with no account
// opens the link, sees the unauthenticated preview, creates their account
// inline on the join screen, and only THEN joins — which is how a real new
// household member arrives. This test drives that path end to end, then
// exercises §7.1's "Link zurücksetzen": the old link must stop working and
// the new one must keep working, without minting a third account just to
// prove the new link's preview (the preview call itself is unauthenticated,
// per JoinScreen.svelte, so a bare fresh context is enough).

test('a visitor joins via the invite link, then a reset link retires the old one', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Getränke');
	await openListView(pageA);
	await addItemByTyping(pageA, 'Wasser');
	await expect(pageA.getByText('Alle Änderungen synchronisiert')).toBeVisible();

	const oldLink = await inviteLinkFor(pageA);

	// B: a fresh context with a virtual authenticator but NO account — the
	// §7.6 visitor. addVirtualAuthenticator alone (not registerAccount, which
	// also navigates and registers) so B lands on the invite link first.
	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await addVirtualAuthenticator(pageB);
	await pageB.goto(oldLink);

	// The preview needs no auth (§7.6) — it renders for the signed-out visitor.
	await expect(pageB.getByText(/Getränke/)).toBeVisible();
	await expect(pageB.getByText('Wasser')).toBeVisible();
	await expect(pageB.getByText('Zum Beitreten brauchst du ein Konto.')).toBeVisible();

	// Create the account inline, from the join screen itself (§7.6: "one
	// passkey tap → join" — the account-creation half is AuthScreen embedded
	// right here, not a redirect).
	await nicknameField(pageB).fill('Ben');
	await pageB.getByRole('button', { name: 'Konto erstellen' }).click();

	// The new account joins at once and the list opens ([D-241]): there is
	// no separate "Beitreten" step for someone who signed up to join.
	await expect(pageB).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	// B's session had its first cycle before the join, with no lists: the
	// member line must not wait for a reload (§7.4 trigger (a) is per list).
	await expect(pageB.getByText('geteilt · 2 Mitglieder')).toBeVisible();
	await openListView(pageB);
	await expect(pageB.locator('[data-testid="row"]').filter({ hasText: 'Wasser' })).toBeVisible({
		timeout: 15_000
	});

	// A reopens the share sheet: the roster now lists B's account nickname
	// (§7.4) — proof the join reached the server, not just B's own device.
	await pageA.getByTestId('list-menu').click();
	await pageA.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	await expect(pageA.locator('.roster > *').filter({ hasText: 'Ben' })).toBeVisible({
		timeout: 15_000
	});

	// A resets the invite link (§7.1 "Link zurücksetzen" — one server
	// transaction that revokes the old link and mints a new one together).
	await pageA.getByRole('button', { name: 'Link zurücksetzen' }).click();
	// Confirmed: it retires the link already sent ([D-293]).
	await pageA.getByRole('alertdialog').getByRole('button', { name: 'Zurücksetzen' }).click();
	await expect(
		pageA.getByText('Neuer Link erstellt. Der alte funktioniert nicht mehr.')
	).toBeVisible();
	const newLink = await pageA.locator('[data-testid="invite-link"] span').innerText();
	await pageA.keyboard.press('Escape');
	expect(newLink).not.toBe(oldLink);

	// The OLD link is now dead — a fresh, signed-out visitor sees the §7.6
	// generic invalid-invite state (never distinguish revoked/expired/not-found).
	const ctxC = await browser.newContext();
	const pageC = await ctxC.newPage();
	await pageC.goto(oldLink);
	await expect(
		pageC.getByText('Diese Einladung ist ungültig, abgelaufen oder zurückgezogen.')
	).toBeVisible();

	// The NEW link still previews fine — no need to actually join (and no
	// need for a third account) to prove the reset worked both ways. A FRESH
	// context, not a re-navigation of pageC: JoinScreen reads location.hash
	// in onMount, so a second goto() to the same /join route with only the
	// fragment changed does not remount the component or re-read the new
	// token — a harness artifact, not how a real visitor opens a second link.
	const ctxD = await browser.newContext();
	const pageD = await ctxD.newPage();
	await pageD.goto(newLink);
	await expect(pageD.getByText(/Getränke/)).toBeVisible();

	// [D-310] A revokes the new link, leaving none: it no longer admits a
	// visitor, and B stays a member.
	await pageA.getByTestId('list-menu').click();
	await pageA.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	await pageA.getByRole('button', { name: 'Link zurückziehen' }).click();
	await pageA.getByRole('alertdialog').getByRole('button', { name: 'Zurückziehen' }).click();
	await expect(
		pageA.getByText('Link zurückgezogen. Niemand kann mehr damit beitreten.')
	).toBeVisible();
	await expect(pageA.getByRole('button', { name: 'Link erstellen' })).toBeVisible();
	await expect(pageA.locator('.roster > *').filter({ hasText: 'Ben' })).toBeVisible();
	// [D-330] Opening the sheet again does not bring a link back.
	await pageA.keyboard.press('Escape');
	await pageA.getByTestId('list-menu').click();
	await pageA.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	await expect(pageA.getByText('Diese Liste hat gerade keinen Einladungslink.')).toBeVisible();
	await expect(pageA.getByRole('button', { name: 'Link erstellen' })).toBeVisible();
	await expect(pageA.getByTestId('invite-link')).toHaveCount(0);
	const ctxE = await browser.newContext();
	const pageE = await ctxE.newPage();
	await pageE.goto(newLink);
	await expect(
		pageE.getByText('Diese Einladung ist ungültig, abgelaufen oder zurückgezogen.')
	).toBeVisible();

	await ctxB.close();
	await ctxC.close();
	await ctxD.close();
	await ctxE.close();
	await ctxA.close();
});

// [D-294] Any member shares the live link, not only the one who created it;
// [D-295] and until the join the address carries it, so „Open in Safari" from
// an in-app browser, or a copied address, still opens the invitation.
test('a second member shares the same link, and its address opens elsewhere', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await registerAccount(pageA, 'Anna');
	await createList(pageA, 'Getränke');
	const link = await inviteLinkFor(pageA);

	// Ben joins on his phone, and shares the list himself.
	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await registerAccount(pageB, 'Ben');
	await pageB.goto(link);
	// The join column keeps the focus width with little in it: as a flex
	// item with auto margins it once shrank to its title's width.
	const column = await pageB.locator('.join').boundingBox();
	expect(column?.width).toBe(420);
	await pageB.getByRole('button', { name: 'Beitreten' }).click();
	await expect(pageB).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	expect(await inviteLinkFor(pageB)).toBe(link);

	// A guest opens it in an in-app browser, then in another browser by its address.
	const inApp = await (await browser.newContext()).newPage();
	await inApp.goto(link);
	await expect(inApp.getByText(/Getränke/)).toBeVisible();
	const other = await (await browser.newContext()).newPage();
	await other.goto(inApp.url());
	await expect(other.getByText(/Getränke/)).toBeVisible();
	await expect(other.getByText(/Einladung ist ungültig/)).toHaveCount(0);

	await ctxA.close();
	await ctxB.close();
});
