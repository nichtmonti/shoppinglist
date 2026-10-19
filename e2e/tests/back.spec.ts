// [D-230] The system back (Android's gesture, a browser's back — here
// Playwright's goBack) and the in-app ‹ buttons agree, on every screen:
// - back closes whatever is open — a sheet, a dialog, a menu — before it
//   leaves the screen; on the home, the app's root, it used to close the app;
// - a ‹ goes BACK to the screen it names instead of pushing a fresh copy of it,
//   so back from there never re-enters the screen just left, and back from
//   the home leaves the app instead of walking through every screen visited;
// - a joined list takes the join screen's place, whose token is gone from the
//   URL by then — back to it could only have said the invitation is invalid.
import { expect, test } from './fixtures';
import { backOverLayer, createList, inviteLinkFor, registerAccount } from './helpers';

const path = (url: string): string => new URL(url).pathname;

test('back closes what is open, and the ‹ buttons go back rather than forward', async ({
	page
}) => {
	await registerAccount(page, 'Rosa');
	const listUrl = await createList(page, 'Wochenmarkt');
	const listPath = path(listUrl);

	// A sheet is a history entry: back closes it and stays on the list.
	await page.getByTestId('list-menu').click();
	const settings = page.getByRole('dialog', { name: 'Wochenmarkt' });
	await expect(settings).toBeVisible();
	await backOverLayer(page, 'overlays');
	await expect(settings).toBeHidden();
	expect(path(page.url())).toBe(listPath);

	// The category editor's ‹ goes back to the list it came from...
	await page.getByTestId('list-menu').click();
	await settings.getByRole('button', { name: 'Kategorien bearbeiten' }).click();
	await expect(page).toHaveURL(/\/categories$/);
	await page.getByRole('button', { name: 'Zurück', exact: true }).click();
	await expect(page).toHaveURL(listUrl);

	// ...and the list's ‹ to the home it came from: back, so forward returns.
	await page.getByRole('button', { name: 'Zurück', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Meine Listen' })).toBeVisible();
	await page.goForward();
	await expect(page).toHaveURL(listUrl);
	await page.goBack();
	await expect(page.getByRole('heading', { name: 'Meine Listen' })).toBeVisible();

	// On the home, a dialog opened from a card's menu closes on back, and the
	// home stays — the menu's entry made way for the dialog's.
	await page.getByRole('button', { name: 'Aktionen für Wochenmarkt' }).click();
	await page.getByRole('menuitem', { name: 'Umbenennen' }).click();
	const rename = page.getByRole('dialog', { name: 'Umbenennen' });
	await expect(rename).toBeVisible();
	await backOverLayer(page, 'overlays');
	await expect(rename).toBeHidden();
	await expect(page.getByRole('heading', { name: 'Meine Listen' })).toBeVisible();
	expect(path(page.url())).toBe('/');
});

// A reload (Safari's of a background tab, say) keeps where each screen came
// from, so its ‹ still goes back rather than replacing it with a copy of the
// screen behind. With a sheet open the sheet is gone, but not its entry.
test('after a reload, the ‹ still goes back', async ({ page }) => {
	await registerAccount(page, 'Uwe');
	const listUrl = await createList(page, 'Baumarkt');

	await page.getByTestId('list-menu').click();
	await page
		.getByRole('dialog', { name: 'Baumarkt' })
		.getByRole('button', { name: 'Kategorien bearbeiten' })
		.click();
	await expect(page).toHaveURL(/\/categories$/);
	await page.reload();
	await page.getByRole('button', { name: 'Zurück', exact: true }).click();
	await expect(page).toHaveURL(listUrl);
	await page.goForward();
	await expect(page).toHaveURL(/\/categories$/);
	await page.goBack();
	await expect(page).toHaveURL(listUrl);

	await page.getByTestId('list-menu').click();
	await expect(page.getByRole('dialog', { name: 'Baumarkt' })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => JSON.stringify(history.state ?? null)))
		.toContain('overlays');
	await page.reload();
	await expect(page.getByRole('dialog', { name: 'Baumarkt' })).toBeHidden();
	await page.getByRole('button', { name: 'Zurück', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Meine Listen' })).toBeVisible();
	await page.goForward();
	await expect(page).toHaveURL(listUrl);
});

test('back from a joined list does not land on the spent invitation', async ({ browser }) => {
	const owner = await (await browser.newContext()).newPage();
	await registerAccount(owner, 'Ole');
	await createList(owner, 'WG-Einkauf');
	const invite = await inviteLinkFor(owner);

	const joiner = await (await browser.newContext()).newPage();
	await registerAccount(joiner, 'Jule');
	await joiner.goto(invite);
	await joiner.getByRole('button', { name: 'Beitreten' }).click();
	await expect(joiner).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });

	await joiner.goBack();
	await expect(joiner.getByRole('heading', { name: 'Meine Listen' })).toBeVisible();
	await expect(joiner.getByText('Diese Einladung ist ungültig')).toHaveCount(0);
});

// §9.3 "Mit Einladung beitreten": a pasted invite link, or its bare code,
// goes into the same join screen a tapped link opens. The dialog's history
// entry comes off before the join screen loads, so back from there is the
// home, not the dialog again.
test('a pasted invite link or bare code opens the join screen, and back goes home', async ({
	browser
}) => {
	const owner = await (await browser.newContext()).newPage();
	await registerAccount(owner, 'Olga');
	await createList(owner, 'Hofladen');
	const invite = await inviteLinkFor(owner);

	const joiner = await (await browser.newContext()).newPage();
	await registerAccount(joiner, 'Paul');
	// The cold-start home: the joiner has no list yet.
	const home = joiner.getByText('Willkommen!');
	const dialog = joiner.getByRole('dialog', { name: 'Mit Einladung beitreten' });
	const listName = joiner.getByText('Hofladen', { exact: true });
	const paste = async (text: string) => {
		await joiner.getByRole('button', { name: 'Mit Einladung beitreten' }).click();
		await dialog.getByLabel('Einladungslink oder Code').fill(text);
		await dialog.getByRole('button', { name: 'Mit Einladung beitreten' }).click();
		await expect(joiner.getByRole('heading', { name: 'Liste beitreten' })).toBeVisible();
		await expect(listName).toBeVisible();
	};

	await paste(invite);
	await joiner.goBack();
	await expect(home).toBeVisible();
	expect(path(joiner.url())).toBe('/');
	await expect(dialog).toHaveCount(0);
	// No dead step behind the join screen: one more back leaves the app, which
	// this tab opened on a blank page.
	await joiner.goBack();
	await expect(joiner).toHaveURL('about:blank');
	await joiner.goForward();
	await expect(home).toBeVisible();

	await paste(new URL(invite).hash.slice(1));
	await joiner.getByRole('button', { name: 'Beitreten' }).click();
	await expect(joiner).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
});
