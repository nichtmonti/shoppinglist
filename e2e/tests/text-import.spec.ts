import { expect, test } from './fixtures';
import {
	addItemByTyping,
	chooseItemSort,
	createList,
	itemRow,
	openListView,
	registerAccount
} from './helpers';

// [D-254] a list as text, end to end against the real seed: the manifest's
// share target lands on /import?text=…, the review shows what was recognised,
// and only the confirmation writes. The component suite stubs both writes;
// this is the layer where the new list goes through the real import route and
// the existing one through the real outbox, offline.

// What "Die Einkaufsliste" shares, verbatim (the trailing space included).
const SHARE = `Hamburg


[Obst - Gemüse - Nüsse]
Mango
Paprika, rot

[Saucen - Gewürze - Dressings - Öle]
Gelbe currypaste

[Backwaren]
Brot

[Brotaufstrich]
Ahornsirup

[Müsli - Cornflakes - Cerealien]
Chiasamen
Sonnenblumenkerne

[Kühltheke - Milchprodukte]
Erbsenmilch
`;

test('a shared Die Einkaufsliste list becomes a new list, sorted into our aisles', async ({
	page
}) => {
	await registerAccount(page, 'Hanna');
	// A first list, so the first sync has mirrored the dictionary the review
	// classifies with.
	await createList(page, 'Zuhause');
	await openListView(page);
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill('Schokolad');
	await expect(page.locator('[data-ta-name="Schokolade"]')).toBeVisible({ timeout: 15_000 });

	// The installed app's share: the worker answers it from the cache, so the
	// list never reaches the server's request log.
	await page.evaluate(() => navigator.serviceWorker.ready);
	const fetched: string[] = [];
	page.context().on('request', (request) => {
		if (request.serviceWorker() && request.url().includes('/import?')) fetched.push(request.url());
	});
	await page.goto(`/import?text=${encodeURIComponent(SHARE)}&title=Einkaufsliste`);

	// The review, not a write: the list is named after the text's first line.
	await expect(page.getByLabel('Name der neuen Liste')).toHaveValue('Hamburg');
	await expect(page.getByRole('checkbox', { name: 'Erbsenmilch' })).toBeChecked();
	await expect(page.getByText('8 von 8 ausgewählt')).toBeVisible();
	// The shared text does not stay in the address bar.
	await expect(page).not.toHaveURL(/text=/);
	expect(fetched).toEqual([]);

	await page.getByRole('checkbox', { name: 'Chiasamen' }).uncheck();
	await page.getByRole('button', { name: 'Liste mit 7 Artikeln erstellen' }).click();

	await expect(page).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	await expect(page.getByRole('button', { name: 'Hamburg', exact: true })).toBeVisible();
	await openListView(page);
	await chooseItemSort(page, 'az');
	const aisle = (name: string) => itemRow(page, name).locator('[data-testid="cat-chip"]');
	await expect(aisle('Mango')).toHaveAttribute('aria-label', /^Obst & Gemüse, /);
	// Unknown by name: its section's "Obst" placed it.
	await expect(aisle('Paprika, rot')).toHaveAttribute('aria-label', /^Obst & Gemüse, /);
	await expect(aisle('Brot')).toHaveAttribute('aria-label', /^Brot & Backwaren, /);
	await expect(aisle('Erbsenmilch')).toHaveAttribute('aria-label', /^Milch & Kühlregal, /);
	await expect(itemRow(page, 'Chiasamen')).toHaveCount(0);
	await expect(page.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});
});

// [D-292] Safari reloads a tab in the background: the shared list is still
// there, and one Back leaves the review, as before the reload.
test('a shared list survives a reload of the review, and one Back leaves it', async ({ page }) => {
	await registerAccount(page, 'Hanna');
	await page.goto(`/import?text=${encodeURIComponent(SHARE)}&title=Einkaufsliste`);
	const name = page.getByLabel('Name der neuen Liste');
	await expect(name).toHaveValue('Hamburg');

	await page.reload();
	await expect(name).toHaveValue('Hamburg');

	await page.goBack();
	await expect(name).toHaveCount(0);
	await expect(page).toHaveURL(/\/import$/);
});

test('text into an existing list, offline: only what it lacks, through the outbox', async ({
	page,
	context
}) => {
	await registerAccount(page, 'Ole');
	await createList(page, 'Wocheneinkauf');
	await openListView(page);
	await addItemByTyping(page, 'Milch');
	await expect(page.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});

	// Mealie's Markdown copy (a heading, checkboxes, an amount in front),
	// pasted into the add field: a list goes to the review ([D-271]).
	await page.getByRole('combobox', { name: 'Artikel hinzufügen' }).evaluate((input, text) => {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		input.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
		);
	}, '# Einkauf\n- [ ] Milch\n- [ ] 2 Brot\n- [ ] Eier');
	await expect(page).toHaveURL(/\/list\/[^/]+\/import$/);

	const milk = page.getByRole('checkbox', { name: 'Milch' });
	await expect(milk).toBeDisabled();
	await expect(milk).toHaveAccessibleDescription('schon auf der Liste');

	await context.setOffline(true);
	await page.getByRole('button', { name: '2 Artikel hinzufügen' }).click();
	await expect(page.getByText('2 Artikel hinzugefügt')).toBeVisible();
	await expect(itemRow(page, 'Brot')).toBeVisible();
	await expect(itemRow(page, 'Brot')).toContainText('2');
	await expect(itemRow(page, 'Eier')).toBeVisible();
	await expect(itemRow(page, 'Milch')).toHaveCount(1);

	await context.setOffline(false);
	await expect(page.getByText('Alle Änderungen synchronisiert').first()).toBeVisible({
		timeout: 15_000
	});
});
