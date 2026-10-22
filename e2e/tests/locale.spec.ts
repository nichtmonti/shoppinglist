import { expect, test } from './fixtures';
import {
	addVirtualAuthenticator,
	createList,
	inviteLinkFor,
	itemRow,
	openListView,
	openShopView,
	registerAccount,
	storedMeta
} from './helpers';

// A de↔en locale switch re-renders seeded vocab while the item↔category
// mapping and history survive. "Gurke" is item_dictionary's
// German name for item_cucumber (backend/seed/items.json), whose
// default_category "produce" seeds as "Obst & Gemüse" (de) / "Produce" (en)
// (backend/seed/categories.json) — exactly tier-2 seeded vocab (§12.2), while
// the item's own free-text name is tier-3 and must never translate.
test('de↔en locale switch re-renders seeded vocab while item↔category mapping and history survive', async ({
	page
}) => {
	await registerAccount(page, 'Anna');
	const listUrl = await createList(page, 'Wochenshop');
	await openListView(page);

	// Pick the dictionary suggestion, so the aisle comes from its
	// default_category (§9) rather than [D-48]'s head-noun fallback for
	// as-typed adds — click the hit so "Gurke"
	// actually lands under produce/"Obst & Gemüse", not "Sonstiges". Wait for
	// the suggestion's category chip to actually resolve first — the same race
	// add-bar.svelte.test.ts guards against: clicking before it resolves would
	// silently categorize into Others. createList() mirrors list_categories
	// locally right away (#lib/actions/lists.ts), so this is a plain reactive
	// wait, not a race.
	await page.getByRole('combobox', { name: 'Artikel hinzufügen' }).fill('Gur');
	await expect(page.locator('[data-ta-name="Gurke"] .ta-cat')).toHaveText('Obst & Gemüse');
	await page.locator('[data-ta-name="Gurke"]').click();
	await expect(itemRow(page, 'Gurke')).toBeVisible();

	// By-category grouping, where both views start ([D-115]), surfaces the
	// seeded aisle label in German.
	await expect(page.getByText('Obst & Gemüse')).toBeVisible();

	// Switch the UI language to English via settings, item still active — the
	// aisle header only renders for the ACTIVE list, so this has to happen
	// before checking "Gurke" off. The ⚙︎ settings link only lives on the
	// lists-home screen (the in-list route has its own, unrelated per-list
	// ⋮ sheet) — navigate directly.
	await page.goto('/settings');
	await page.getByRole('radio', { name: 'English' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
	// The screen switches before the choice is stored, and the goto below
	// would abort that write.
	await expect.poll(() => storedMeta(page, 'locale')).toBe('en');
	await page.getByRole('button', { name: 'Back' }).click();
	// settings' back() always returns to home (/), not the previously-open
	// list — re-enter it directly. No need to reselect the list-view tab: it's
	// a persisted device pref (§9.1, meta.list_view) that survives navigation,
	// and re-clicking it by its (now stale, German) label would fail anyway.
	await page.goto(listUrl);

	// item↔category mapping survives untouched: same item, same category
	// assignment — only the aisle's DISPLAY LABEL re-rendered, English now.
	await expect(page.getByText('Produce')).toBeVisible();
	await expect(page.getByText('Obst & Gemüse')).toHaveCount(0);
	await expect(itemRow(page, 'Gurke')).toBeVisible();

	// Check it off now — in the shop view (§9.1: list view is planning-only).
	// The item's own free-text name is never translated (§12.2's tier 3).
	await openShopView(page);
	await page.locator('[data-testid="tile"]', { hasText: 'Gurke' }).click();
	await expect(page.locator('[data-testid="done-head"]')).toBeVisible();
	await expect(page.locator('[data-testid="done-row"]', { hasText: 'Gurke' })).toBeVisible();

	// Round-trip back to German completes the de↔en switch, and history
	// survives that switch too. Wait for the German heading before clicking
	// the (now German) back button.
	await page.goto('/settings');
	await page.getByRole('radio', { name: 'Deutsch' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
	await expect.poll(() => storedMeta(page, 'locale')).toBe('de');
	await page.getByRole('button', { name: 'Zurück' }).click();
	await page.goto(listUrl);
	await expect(page.getByTestId('view-toggle-shop')).toHaveText(/Einkaufen/);
	await expect(page.locator('[data-testid="done-head"]')).toBeVisible();
	await expect(page.locator('[data-testid="done-row"]', { hasText: 'Gurke' })).toBeVisible();
	// Still checked off, not back on the active tiles.
	await expect(page.locator('[data-testid="tile"]', { hasText: 'Gurke' })).toHaveCount(0);
});

// [D-291] [D-292] The invitation screen holds a token it took out of the URL;
// a language switch there, either way, and a reload of the tab keep it.
test('an invitation survives a language switch and a reload', async ({ browser }) => {
	const owner = await (await browser.newContext()).newPage();
	await registerAccount(owner, 'Anna');
	await createList(owner, 'Getränke');
	const link = await inviteLinkFor(owner);

	const guest = await (await browser.newContext()).newPage();
	await addVirtualAuthenticator(guest);
	await guest.goto(link);
	await expect(guest.getByText('Getränke')).toBeVisible();

	const toggle = guest.getByTestId('auth-locale');
	await toggle.getByRole('radio', { name: 'English' }).click();
	await expect(guest.getByRole('heading', { level: 1, name: 'Join list' })).toBeVisible();
	await expect(guest.getByText('Getränke')).toBeVisible();

	await toggle.getByRole('radio', { name: 'Deutsch' }).click();
	await expect(guest.getByRole('heading', { level: 1, name: 'Liste beitreten' })).toBeVisible();
	await expect(guest.getByText('Getränke')).toBeVisible();

	await guest.reload();
	await expect(guest.getByText('Getränke')).toBeVisible();
	await expect(guest.getByRole('alert')).toHaveCount(0);
});

// [D-291] The language is shared by every tab of the app, and a switch in one
// changes the others in place: what they hold, a half-typed item here, stays.
test('a language switch in one tab relabels another without losing what it holds', async ({
	browser
}) => {
	const context = await browser.newContext();
	const listTab = await context.newPage();
	await registerAccount(listTab, 'Anna');
	await createList(listTab, 'Wochenshop');
	await openListView(listTab);
	await listTab.getByRole('combobox', { name: 'Artikel hinzufügen' }).fill('Kartof');

	const settingsTab = await context.newPage();
	await settingsTab.goto('/settings');
	await settingsTab.getByRole('radio', { name: 'English' }).click();
	await expect(settingsTab.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

	const field = listTab.getByRole('combobox', { name: 'Add item' });
	await expect(field).toBeVisible();
	await expect(field).toHaveValue('Kartof');
	await expect(listTab.locator('html')).toHaveAttribute('lang', 'en');
});
