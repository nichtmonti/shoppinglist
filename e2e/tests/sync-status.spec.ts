import { expect, test } from './fixtures';
import { addItemByTyping, createList, openListView, registerAccount } from './helpers';

// [D-296] When changes do not get out, the line under the list's name says
// why, in place of the members, and its sheet sends them on request. Against
// the real server, its push route answering 503 as a server that is down.
test('a server that keeps failing is named under the list, and „Jetzt senden“ sends once it is back', async ({
	page
}) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');
	await openListView(page);
	await expect(page.getByText('nur du')).toBeVisible();

	let down = true;
	await page.route('**/api/sync/push', (route) =>
		down ? route.fulfill({ status: 503, body: '' }) : route.continue()
	);
	await addItemByTyping(page, 'Milch');

	// Three failed tries in a row: the first, and the 5 s retries.
	const line = page.getByTestId('sync-line');
	await expect(line).toHaveText(/Server antwortet nicht/, { timeout: 40_000 });
	await expect(page.getByText('nur du')).toHaveCount(0);

	down = false;
	await line.click();
	const sheet = page.getByRole('dialog', { name: '1 Änderung nicht synchronisiert' });
	await expect(sheet).toContainText('Der Server antwortet gerade nicht.');
	await sheet.getByRole('button', { name: 'Jetzt synchronisieren' }).click();

	await expect(line).toHaveCount(0);
	await expect(page.getByText('nur du')).toBeVisible();
	await expect(page.getByText('Alle Änderungen synchronisiert')).toBeAttached();
});

// [D-296] The title's two taps: the name switches lists, the line under it
// shows who is on the list. Their boxes meet where the rows meet, without a
// gap or an overlap, and the line is a 24px target within the 56px bar.
test('the name opens the quick switcher and the line under it the members, side by side', async ({
	page
}) => {
	await registerAccount(page, 'Anna');
	await createList(page, 'Wochenshop');

	const name = page.getByRole('button', { name: /^Wochenshop/ }).first();
	const line = page.getByTestId('members-line');
	await expect(line).toHaveText(/nur du/);
	const nameBox = (await name.boundingBox())!;
	const lineBox = (await line.boundingBox())!;
	expect(Math.abs(lineBox.y - (nameBox.y + nameBox.height))).toBeLessThanOrEqual(1.5);
	expect(lineBox.height).toBeGreaterThanOrEqual(24);

	await line.click();
	const members = page.getByRole('dialog', { name: 'Teilen & Mitglieder' });
	await expect(members).toContainText('Anna');
	await page.keyboard.press('Escape');
	await expect(members).toHaveCount(0);

	await name.click();
	await expect(page.getByRole('dialog', { name: 'Listen' })).toBeVisible();
});
