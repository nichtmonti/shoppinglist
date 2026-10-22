import { expect, test } from './fixtures';
import {
	addItemByTyping,
	createList,
	itemRow,
	openListView,
	openShopView,
	registerAccount
} from './helpers';

// WCAG audit — checks axe cannot do: keyboard-only operation (focus visible,
// sheet open/close/trap/restore), touch-target sweep (WCAG 2.5.8 ≥24px
// painted or ≥44px effective via the ::after hit-expansion idiom), 320px
// reflow (1.4.10), text-spacing override (1.4.12), and per-locale `lang`
// (3.1.1) plus per-route document titles (2.4.2).

test.describe.configure({ retries: 0, mode: 'serial' });

async function setup(page: import('@playwright/test').Page): Promise<string> {
	await registerAccount(page, 'Kai');
	const listUrl = await createList(page, 'Küche');
	await openListView(page);
	await addItemByTyping(page, 'Milch');
	await itemRow(page, 'Milch').getByRole('button', { name: 'Menge hinzufügen' }).click();
	await page.keyboard.type('1 l');
	await page.keyboard.press('Enter');
	return listUrl;
}

test('keyboard-only: visible focus, sheet opens/closes, trap holds, focus restores', async ({
	page
}) => {
	await setup(page);

	// Focus the first row's name button by real Tab presses from the add bar.
	await page.getByRole('combobox', { name: 'Artikel hinzufügen' }).focus();
	let focused = '';
	for (let i = 0; i < 30; i++) {
		await page.keyboard.press('Tab');
		focused = await page.evaluate(() => {
			const el = document.activeElement;
			return el ? `${el.tagName}.${el.className}` : '';
		});
		if (focused.includes('row-name')) break;
	}
	expect(focused, 'Tab should reach a row name button').toContain('row-name');

	// Visible focus indicator while keyboard-driven.
	const outline = await page.evaluate(() => {
		const cs = getComputedStyle(document.activeElement as Element);
		return { style: cs.outlineStyle, width: cs.outlineWidth };
	});
	expect(outline.style).toBe('solid');
	expect(parseFloat(outline.width)).toBeGreaterThan(0);

	// Enter opens the detail sheet.
	await page.keyboard.press('Enter');
	await expect(page.getByRole('heading', { name: 'Artikel bearbeiten' })).toBeVisible();

	// The Tab trap: focus never leaves the dialog across many Tab presses.
	let escaped = false;
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Tab');
		const inside = await page.evaluate(() =>
			Boolean(document.activeElement?.closest('[role="dialog"]'))
		);
		if (!inside) {
			escaped = true;
			break;
		}
	}
	expect(escaped, 'Tab must stay inside the open dialog').toBe(false);

	// Escape closes and focus returns to the opener.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('heading', { name: 'Artikel bearbeiten' })).toHaveCount(0);
	const restored = await page.evaluate(() => {
		const el = document.activeElement;
		return el ? `${el.tagName}.${el.className}` : '';
	});
	expect(restored, 'focus should return to the row name button').toContain('row-name');
});

test('touch targets: every interactive element meets ≥24px painted or ≥44px effective', async ({
	page
}) => {
	await setup(page);
	const offenders: string[] = [];

	async function sweep(label: string): Promise<void> {
		const found = await page.evaluate(() => {
			const els = Array.from(
				document.querySelectorAll<HTMLElement>(
					'button, a, input, [role="button"], [tabindex="0"], [role^="menuitem"]'
				)
			).filter((e) => {
				const r = e.getBoundingClientRect();
				const s = getComputedStyle(e);
				return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
			});
			const bad: string[] = [];
			for (const e of els) {
				const r = e.getBoundingClientRect();
				// [D-56]: primary controls ([data-slot="button"] — the Button
				// component) and menu entries are held to a 44px painted floor;
				// everything else keeps WCAG 2.5.8 AA's 24px. Below-floor buttons
				// still pass if their ::after hit expansion reaches 44px effective
				// (below).
				const floor = e.matches('[data-slot="button"], [role^="menuitem"]') ? 44 : 24;
				if (r.width >= floor && r.height >= floor) continue;
				// Each side of the ::after expansion on its own (the app bar's ‹
				// reaches further toward the chip than into the margin, [D-272]),
				// counting only what is on screen: past the edge is not tappable.
				const after = getComputedStyle(e, '::after');
				const grow = (v: string) => {
					const n = parseFloat(v);
					return after.position === 'absolute' && n < 0 ? -n : 0;
				};
				const left = Math.max(0, r.left - grow(after.left));
				const right = Math.min(innerWidth, r.right + grow(after.right));
				const top = Math.max(0, r.top - grow(after.top));
				const bottom = Math.min(innerHeight, r.bottom + grow(after.bottom));
				const effW = right - left;
				const effH = bottom - top;
				if (effW < 44 || effH < 44) {
					bad.push(
						`${e.tagName}.${String(e.className).split(' ').join('.')} ` +
							`painted ${Math.round(r.width)}x${Math.round(r.height)} ` +
							`effective ${Math.round(effW)}x${Math.round(effH)}`
					);
				}
			}
			return bad;
		});
		offenders.push(...found.map((f) => `${label}: ${f}`));
	}

	// Each sweep after a marker of what it sweeps: one before it would measure
	// the screen before, or a menu not yet open, and pass on fewer targets.
	const menu = page.getByRole('menu');
	await sweep('list');
	await page.getByTestId('item-sort').click();
	await expect(menu).toBeVisible();
	await sweep('item sort menu');
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await openShopView(page);
	await expect(page.getByTestId('tile').first()).toBeVisible();
	await sweep('shop');
	await page.goto('/');
	await page.getByRole('button', { name: 'Aktionen für Küche' }).click();
	await expect(menu).toBeVisible();
	await sweep('list card menu');
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await page.getByTestId('list-sort').click();
	await expect(menu).toBeVisible();
	await sweep('list sort menu');
	await page.keyboard.press('Escape');
	await page.goto('/settings');
	await expect(page.getByTestId('app-version')).toBeVisible();
	await sweep('settings');

	expect(offenders, 'targets below 24px painted and below 44px effective').toEqual([]);
});

test('reflow at 320px (1.4.10) and text-spacing override (1.4.12) cause no clipping', async ({
	page
}) => {
	await setup(page);
	await openShopView(page);
	await page.locator('[data-testid="tile"]', { hasText: 'Milch' }).click(); // checked → done section + toast
	// AWAITED, not assumed. The check-off re-renders through a liveQuery, so
	// the instant after the click the DOM may be the settled done-list (fast
	// machine) or still the active tile (slow CI agent); measuring before it
	// settles would measure a different subject per machine.
	await expect(page.locator('[data-testid="tile"]')).toHaveCount(0);

	await page.setViewportSize({ width: 320, height: 568 });
	const reflow = await page.evaluate(() => ({
		doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		overflowers: Array.from(
			document.querySelectorAll<HTMLElement>('main, .app-shell, .row, .grid, .tile, .addbar')
		)
			// `.grid` is Tailwind's display:grid UTILITY, not the aisle grid, so
			// this list also picks up small centred controls: the tile's info
			// door, the aisle chevron, the done-row check. Only the door reports
			// an overflow, and only because it carries `hit-target` — an ::after
			// at `position:absolute; inset:-7px` that paints 7px OUTSIDE the 28px
			// control to reach WCAG 2.5.8's 44px effective target. That makes
			// scrollWidth exceed clientWidth BY DESIGN while nothing is clipped:
			// overflow stays visible and the content is a 15px icon. The
			// touch-target test above REQUIRES that expansion to exist, so
			// reading it as a reflow failure here is a false positive — and it is
			// the only thing this check has ever fired on.
			.filter((e) => !e.classList.contains('hit-target'))
			.filter((e) => e.scrollWidth > e.clientWidth + 2)
			.map((e) => `${e.tagName}.${String(e.className).split(' ').join('.')}`)
	}));
	expect(reflow.doc, 'no horizontal page scroll at 320px').toBeLessThanOrEqual(2);
	expect(reflow.overflowers, 'no element clips horizontally at 320px').toEqual([]);

	// The app's CSP locks style-src to 'self' plus one hashed inline <style>
	// (mode-watcher's transition shim), so the override goes through a
	// constructable stylesheet — CSSOM bypasses the CSP and the rules still
	// cascade exactly like a real <style> block.
	await page.evaluate(() => {
		const sheet = new CSSStyleSheet();
		sheet.insertRule(
			'* { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; line-height: 1.5 !important; }'
		);
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	});
	const spacing = await page.evaluate(() => ({
		doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		overflowers: Array.from(
			document.querySelectorAll<HTMLElement>('main, .app-shell, .row, .grid, .tile, .addbar')
		)
			// `.grid` is Tailwind's display:grid UTILITY, not the aisle grid, so
			// this list also picks up small centred controls: the tile's info
			// door, the aisle chevron, the done-row check. Only the door reports
			// an overflow, and only because it carries `hit-target` — an ::after
			// at `position:absolute; inset:-7px` that paints 7px OUTSIDE the 28px
			// control to reach WCAG 2.5.8's 44px effective target. That makes
			// scrollWidth exceed clientWidth BY DESIGN while nothing is clipped:
			// overflow stays visible and the content is a 15px icon. The
			// touch-target test above REQUIRES that expansion to exist, so
			// reading it as a reflow failure here is a false positive — and it is
			// the only thing this check has ever fired on.
			.filter((e) => !e.classList.contains('hit-target'))
			.filter((e) => e.scrollWidth > e.clientWidth + 2)
			.map((e) => `${e.tagName}.${String(e.className).split(' ').join('.')}`)
	}));
	expect(spacing.doc, 'no horizontal page scroll under text-spacing').toBeLessThanOrEqual(2);
	expect(spacing.overflowers, 'no element clips under text-spacing').toEqual([]);
});

test('lang switches per locale (3.1.1) and every route sets a title (2.4.2)', async ({ page }) => {
	await registerAccount(page, 'Lea');
	const listUrl = await createList(page, 'Bad');

	expect(await page.evaluate(() => document.documentElement.lang)).toBe('de');
	// Each route's own title: app.html's static one is there before any route
	// sets its title, so "not empty" held from the start.
	for (const [path, title] of [
		['/settings', 'Einstellungen'],
		[`${listUrl}/categories`, 'Kategorien'],
		[listUrl, 'Bad']
	]) {
		await page.goto(path);
		await expect(page, `title on ${path}`).toHaveTitle(title);
	}

	await page.goto('/settings');
	await page.getByRole('radio', { name: 'English' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
	// The <html lang> flips via a layout effect on hydration — poll rather than
	// assert once, or a slow hydrate loses the race.
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), {
			message: 'lang should flip to en on the settings screen'
		})
		.toBe('en');

	await page.goto(listUrl);
	// The booted list in English first: app.html's own lang is "en" too.
	await expect(page.getByTestId('view-toggle-shop')).toHaveText(/Shopping/);
	await expect
		.poll(() => page.evaluate(() => document.documentElement.lang), {
			message: 'lang should survive a hard navigation to the list'
		})
		.toBe('en');
	await expect(page).toHaveTitle('Bad');
});
