import { expect, test, type Browser, type Page } from './fixtures';
import { addVirtualAuthenticator, createList, inviteLinkFor } from './helpers';
import { INVITE_PORT } from '../server';

// [D-241] SHOPPINGLIST_SIGNUP=invite, end to end on a real server
// (playwright.config.ts boots it beside the suite's own, with an empty
// database): the first account comes in through the setup link the server
// printed to its log, a family member through a list's invite link — and
// lands on that list — and nobody without a link gets an account.
//
// One journey, in order, and no retry: the setup link admits exactly one
// account, so a second attempt against the same server could only fail.
test.describe.configure({ mode: 'serial', retries: 0 });

const ORIGIN = `http://localhost:${INVITE_PORT}`;

/** The setup link from the server's boot log (inviteOnlyServer). */
function setupLink(): string {
	const link = process.env.SETUP_LINK;
	if (!link) throw new Error('no setup link: the invite-only server printed none');
	return link;
}

async function newDevice(browser: Browser): Promise<Page> {
	const page = await (await browser.newContext()).newPage();
	await addVirtualAuthenticator(page);
	return page;
}

async function createAccount(page: Page, nickname: string): Promise<void> {
	await page.getByLabel('Spitzname', { exact: true }).fill(nickname);
	await page.getByRole('button', { name: 'Konto erstellen' }).click();
}

test('the first account by the setup link, the next by a list invite, none without a link', async ({
	browser
}) => {
	const stranger = await newDevice(browser);
	await stranger.goto(ORIGIN + '/');
	await expect(stranger.getByText(/nur mit einem Einladungslink/)).toBeVisible();
	await expect(stranger.getByRole('button', { name: 'Konto erstellen' })).toHaveCount(0);

	const link = setupLink();
	expect(link.startsWith(ORIGIN + '/#setup=')).toBe(true);

	const owner = await newDevice(browser);
	await owner.goto(link);
	// The token leaves the address bar as soon as it is read.
	await expect(owner).toHaveURL(ORIGIN + '/');
	await createAccount(owner, 'Alice');
	await expect(owner.getByText('Willkommen!')).toBeVisible({ timeout: 15_000 });
	await createList(owner, 'Familie');
	const invite = await inviteLinkFor(owner);
	expect(invite.startsWith(ORIGIN + '/join#')).toBe(true);

	// The family member: the invite's preview, an account, and the list.
	const joiner = await newDevice(browser);
	await joiner.goto(invite);
	await expect(joiner.getByText('Zum Beitreten brauchst du ein Konto.')).toBeVisible();
	await createAccount(joiner, 'Bob');
	await expect(joiner).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	await expect(joiner.getByRole('button', { name: 'Familie', exact: true })).toBeVisible();

	// The setup link is spent: an account exists.
	const late = await newDevice(browser);
	await late.goto(link);
	await createAccount(late, 'Mallory');
	await expect(late.getByText('Dieser Link gilt nicht mehr. Bitte um einen neuen.')).toBeVisible();
	await expect(late.getByText('Willkommen!')).toHaveCount(0);
});
