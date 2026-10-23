import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync } from 'node:fs';
import {
	addItemByTyping,
	createList,
	itemRow,
	nicknameField,
	openListView,
	openShopView,
	registerAccount,
	showInviteLink
} from './helpers';

// WCAG audit — the axe runtime scan. Walks every screen state the app
// can reach (auth, home, list empty/filled/grouped, typeahead, qty editor,
// detail sheet, shop, previous items, scan overlay, settings, categories,
// share sheet), in German+English and light+dark, and collects every axe
// violation + incomplete ("needs review") into test-results/a11y-findings.json.
// Two serial tests share one page; afterAll fails iff any violation was found.
// The JSON is the report input.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Sonner fades toasts in/out with opacity keyframes and has no library-level
// prefers-reduced-motion support of its own. A snapshot taken mid-fade
// composites the undo pill's fg AND bg toward the page behind it (a pair that
// is 4.63:1 at rest can read as ~3:1), so the result would depend on scan
// timing, not on the UI. The app
// collapses all animation/transition under prefers-reduced-motion
// (app.css), so emulating that setting makes every snapshot deterministic at
// the element's final state while keeping it fully in scope for measurement.
const frozen = new WeakSet<import('@playwright/test').Page>();

async function freezeAnimations(page: import('@playwright/test').Page): Promise<void> {
	if (frozen.has(page)) return;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	frozen.add(page);
}

type Scan = {
	state: string;
	label: string;
	theme: string;
	locale: string;
	title: string;
	violations: { id: string; impact?: string | null; nodes: unknown[] }[];
	incomplete: unknown[];
};

const scans: Scan[] = [];
let totalViolations = 0;

async function scan(
	page: import('@playwright/test').Page,
	state: string,
	label: string
): Promise<void> {
	await freezeAnimations(page);
	// Never a screen still loading: its placeholder would be scanned instead.
	// The caller has waited for a marker of the screen itself, which a
	// placeholder-free page before any render satisfies as well as this does.
	await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
	const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
	const violations = results.violations.map((v) => ({
		id: v.id,
		impact: v.impact,
		help: v.help,
		helpUrl: v.helpUrl,
		nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary }))
	}));
	const incomplete = results.incomplete.map((i) => ({
		id: i.id,
		impact: i.impact,
		nodes: i.nodes.map((n) => n.target)
	}));
	totalViolations += violations.length;
	const theme = await page.evaluate(() =>
		matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
	);
	const locale = await page.evaluate(() => document.documentElement.lang);
	const title = await page.title();
	scans.push({ state, label, theme, locale, title, violations, incomplete });
}

test.describe.configure({ retries: 0, mode: 'serial' });

test.afterAll(() => {
	writeFileSync(
		new URL('../test-results/a11y-findings.json', import.meta.url),
		JSON.stringify({ scans, totalViolations }, null, 2)
	);
	console.log(`A11Y-SCAN ${scans.length} states scanned, ${totalViolations} violations total`);
	for (const s of scans) {
		if (s.violations.length > 0) {
			console.log(
				`A11Y-VIOLATION ${s.label}: ${s.violations
					.map((v) => `${v.id}(${v.impact}, ${v.nodes.length} nodes)`)
					.join(', ')}`
			);
		}
	}
	expect(totalViolations, 'axe violations found — see test-results/a11y-findings.json').toBe(0);
});

test('axe scan: German light walk (auth → previous items)', async ({ page }) => {
	// 1. Anonymous auth screen (login form, before any ceremony).
	await page.goto('/');
	await expect(nicknameField(page)).toBeVisible();
	await scan(page, 'auth', 'auth-login');

	// 2. Cold-start home with the "Willkommen!" toast.
	await registerAccount(page, 'Aria');
	await scan(page, 'home', 'home-toast');

	// 3. Empty list view.
	const listUrl = await createList(page, 'Wochenshop');
	await openListView(page);
	await scan(page, 'list', 'list-empty');

	// 4. Filled list: two plain adds, one category-suggested (Gurke).
	await addItemByTyping(page, 'Milch');
	await addItemByTyping(page, 'Brot');
	await page.getByRole('combobox', { name: 'Artikel hinzufügen' }).fill('Gur');
	await expect(page.locator('[data-ta-name="Gurke"] .ta-cat')).toHaveText('Obst & Gemüse');

	// 5. Open typeahead with suggestions (dictionary + typed-add rows).
	await expect(page.locator('[data-ta-name="Gurke"]')).toBeVisible();
	await scan(page, 'typeahead', 'typeahead-open');
	await page.locator('[data-ta-name="Gurke"]').click();
	await expect(itemRow(page, 'Gurke')).toBeVisible();

	// 6. Inline quantity editor (chip → input).
	await itemRow(page, 'Milch').getByRole('button', { name: 'Menge hinzufügen' }).click();
	await expect(itemRow(page, 'Milch').locator('.qty-edit')).toBeFocused();
	await scan(page, 'qty-edit', 'qty-editor-open');
	await page.keyboard.type('500 g');
	await page.keyboard.press('Enter');

	// 7. Detail sheet (note filled, quantity shown).
	await itemRow(page, 'Milch').getByRole('button', { name: 'Milch', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Artikel bearbeiten' })).toBeVisible();
	await page.getByPlaceholder('z. B. nur Marke X').fill('haltbar');
	await scan(page, 'detail-sheet', 'detail-sheet-note');
	await page.keyboard.press('Escape');

	// 8. By-category grouping (aisle headers), where both views start
	// ([D-115]): the pick keeps it, and the scan waits for the menu to go.
	await page.getByTestId('item-sort').click();
	await expect(page.getByRole('menu')).toBeVisible();
	await scan(page, 'item-order', 'item-order-menu');
	await page.getByRole('menuitemradio', { name: 'Kategorie' }).click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(page.getByText('Obst & Gemüse').first()).toBeVisible();
	await scan(page, 'list', 'list-grouped');

	// 9. Shop view, unchecked tiles.
	await openShopView(page);
	await expect(page.getByTestId('tile').first()).toBeVisible();
	await scan(page, 'shop', 'shop-tiles');

	// 10. Check one off — ShopView's done section, toast.
	await page.locator('[data-testid="tile"]', { hasText: 'Milch' }).click();
	await expect(page.locator('[data-testid="done-head"]')).toBeVisible();
	await scan(page, 'shop', 'shop-checked');

	// 11. Previous-items screen.
	await page.goto(`${listUrl}/previous`);
	// The route's own title: the URL is there before the screen is.
	await expect(page).toHaveTitle(/Frühere Artikel/);
	await scan(page, 'previous', 'previous-items');
});

test('axe scan: settings, categories, share, English, dark', async ({ page }) => {
	await page.goto('/');
	await registerAccount(page, 'Aria2');
	const listUrl = await createList(page, 'Wochenshop');

	// 13. Settings screen.
	await page.goto('/settings');
	await expect(page.getByTestId('app-version')).toBeVisible();
	await scan(page, 'settings', 'settings');

	// 14. Category editor page.
	await page.goto(`${listUrl}/categories`);
	await expect(page.getByText('Obst & Gemüse').first()).toBeVisible();
	await scan(page, 'categories', 'category-editor');

	// 15. Share sheet (invite link visible).
	await page.goto(listUrl);
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	await showInviteLink(page);
	await scan(page, 'share', 'share-sheet');
	await page.keyboard.press('Escape');

	// 16. English locale: settings → list → shop.
	await page.goto('/settings');
	await page.getByRole('radio', { name: 'English' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
	await page.getByRole('button', { name: 'Back' }).click();
	await page.goto(listUrl);
	await openListView(page);
	await scan(page, 'list', 'list-en');
	await openShopView(page);
	await scan(page, 'shop', 'shop-en');

	// 17. Dark theme (English): home, list, shop, settings.
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Open Wochenshop' })).toBeVisible();
	await scan(page, 'home', 'home-dark');
	await page.goto(listUrl);
	await openListView(page);
	await scan(page, 'list', 'list-dark');
	await openShopView(page);
	await scan(page, 'shop', 'shop-dark');
	await page.goto('/settings');
	await expect(page.getByTestId('app-version')).toBeVisible();
	await scan(page, 'settings', 'settings-dark');
});

test('axe scan: scan overlay unsupported state (mediaDevices stubbed)', async ({ browser }) => {
	const ctx = await browser.newContext();
	await ctx.addInitScript(() => {
		Object.defineProperty(navigator, 'mediaDevices', { value: undefined });
	});
	const p2 = await ctx.newPage();
	await p2.goto('/');
	await registerAccount(p2, 'Aria2');
	await createList(p2, 'Wochenshop');
	await openListView(p2);
	// Freeze the page clock so the unsupported-state auto-reset (1.2s) cannot
	// close the overlay while axe is analysing; under load the reset can
	// otherwise race the analysis.
	await p2.clock.install();
	await p2.getByRole('button', { name: 'Barcode scannen' }).click();
	await expect(p2.locator('[data-testid="scan-message"]')).toBeVisible();
	await scan(p2, 'scan', 'scan-unsupported');
	await p2.keyboard.press('Escape');
	await ctx.close();
});
