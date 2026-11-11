import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginAtDex } from '../oidc/dex';
import {
	addVirtualAuthenticator,
	disableConditionalMediation,
	showInviteLink
} from '../tests/helpers';
import { INVITE_ORIGIN } from './docs.config';
import { createAccount, createList, device, msg as message, settle, shoot } from './shots';

// The deployment reference's screenshots (docs.config.ts), in English like
// the reference, light theme. Saved as OUT/docs/<name>.png; scripts/shots.sh
// docs copies them to docs/images/. Every label comes from the app's own
// catalogue, so a reworded message cannot leave a stale selector behind.

/** The app's English copy for `key`, with `{name}`-style values filled in. */
const msg = (key: string, values: Record<string, string> = {}) =>
	message('en', key).replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);

/** A fresh phone, in English and the light theme. */
const phone = async (browser: Browser) => (await device(browser, 'en', 'light')).page;
const at = (name: string) => `docs/${name}`;

/** Opens the open list's share sheet. */
async function openShareSheet(page: Page) {
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: msg('share_title') }).click();
	return page.getByRole('dialog', { name: msg('share_title') });
}

/** The settings group that holds the nickname and, with OIDC on, the login. */
const accountCard = (page: Page) =>
	page.locator('section').filter({ has: page.getByTestId('settings-nickname') });

test('who can sign up: SHOPPINGLIST_SIGNUP=invite', async ({ browser }) => {
	// A stranger: the auth screen without a link.
	const stranger = await phone(browser);
	await disableConditionalMediation(stranger, { acrossNavigations: true });
	await stranger.goto(INVITE_ORIGIN + '/');
	await expect(stranger.getByText(msg('auth_signup_by_link'))).toBeVisible();
	await settle(stranger);
	await shoot(stranger, stranger, at('signup-invite-only'));

	// The first account, through the setup link in the boot log (inviteOnlyServer).
	const setup = process.env.SETUP_LINK ?? '';
	expect(setup).not.toBe('');
	const anna = await phone(browser);
	await addVirtualAuthenticator(anna);
	await anna.goto(setup);
	await createAccount(anna, 'en', 'Anna');
	await expect(anna.getByText(msg('home_empty_title'))).toBeVisible({ timeout: 15_000 });
	await createList(anna, 'en', 'Family');
	await openShareSheet(anna);
	const invite = await (
		await showInviteLink(anna, msg('share_create_link'))
	)
		.locator('span')
		.innerText();
	await anna.keyboard.press('Escape');

	// A family member opening the invite: the list's preview and the sign-up.
	const ben = await phone(browser);
	await addVirtualAuthenticator(ben);
	await disableConditionalMediation(ben, { acrossNavigations: true });
	await ben.goto(invite);
	await expect(ben.getByText(msg('share_join_needs_account'))).toBeVisible();
	await settle(ben);
	await shoot(ben, ben, at('signup-invite-join'));
	await createAccount(ben, 'en', 'Ben');
	await expect(ben).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });

	// The owner's share sheet, with Ben in it: the link and "New link".
	const sheet = await openShareSheet(anna);
	await expect(sheet.getByText('Ben', { exact: true })).toBeVisible();
	await expect(sheet.getByRole('button', { name: msg('share_reset_link') })).toBeVisible();
	await settle(anna);
	await shoot(anna, anna, at('share-sheet'));
});

test('OIDC login: the provider button and the settings card', async ({ browser }) => {
	const dex = msg('auth_oidc_login', { name: 'Dex' });
	const visitor = await phone(browser);
	await disableConditionalMediation(visitor, { acrossNavigations: true });
	await visitor.goto('/');
	await expect(visitor.getByRole('button', { name: dex })).toBeVisible();
	await settle(visitor);
	await shoot(visitor, visitor, at('oidc-signin'));

	// Signed in through the provider: "Connected with Dex as …".
	const popup = visitor.waitForEvent('popup');
	await visitor.getByRole('button', { name: dex }).click();
	await loginAtDex(await popup, 'Anna');
	await expect(visitor.getByText(msg('home_empty_title'))).toBeVisible();
	await visitor.goto('/settings');
	const linked = msg('settings_oidc_linked_as', { name: 'Dex', identity: 'anna@example.com' });
	await expect(accountCard(visitor).getByText(linked)).toBeVisible();
	await settle(visitor);
	await shoot(visitor, accountCard(visitor), at('oidc-settings-linked'));

	// A passkey account: "Link with Dex".
	const clara = await phone(browser);
	await addVirtualAuthenticator(clara);
	await clara.goto('/');
	await createAccount(clara, 'en', 'Clara');
	await expect(clara.getByText(msg('home_empty_title'))).toBeVisible({ timeout: 15_000 });
	await clara.goto('/settings');
	const link = msg('settings_link_oidc', { name: 'Dex' });
	await expect(accountCard(clara).getByRole('button', { name: link })).toBeVisible();
	await settle(clara);
	await shoot(clara, accountCard(clara), at('oidc-settings-link'));
});
