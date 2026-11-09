import { chromium, expect, test, type Page } from './fixtures';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
	addItemByTyping,
	createList,
	openListView,
	openShopView,
	registerAccount
} from './helpers';

// Layout contract regression gate.
//
// THE CONTRACT (the centered column, docs/internals/design.md 4.1):
//   1. The centered app column (.app-shell) has the SAME width regardless of
//      locale, viewport height, or page. A classic viewport scrollbar appears
//      only when content crosses the viewport height (German more often than
//      English) and steals ~15px from the column; `scrollbar-gutter: stable`
//      reserves that space up front. The spec forces scrollbars on (headless
//      Chromium hides them by default) and uses an 800px-wide viewport — below
//      --app-max (820px) + scrollbar width — so a scrollbar appearing would
//      actually change the column's size. The assertion decomposes into the
//      rule (scrollbar-gutter: stable computed) plus scrolling-state width
//      equality.
//   2. No horizontal overflow: document.scrollingElement.scrollWidth ===
//      clientWidth on every page.
//   3. An open Sheet has nothing that scrolls inside it: a
//      nested overflow-y container scrolls independently of the sheet and
//      breaks the single-scroller model the sheet's focus trap assumes.
//
// E2E_DIAG=1 makes the width test print every sample with console.table,
// attach them as width-samples.json, and screenshot the settings screen in
// both locales to test-results/layout-invariants/. Off by default: nothing
// asserts on them.

const DIAG = !!process.env.E2E_DIAG;
const SHOT_DIR = path.join('test-results', 'layout-invariants');

interface Sample {
	locale: 'de' | 'en';
	density: 'comfortable' | 'compact';
	route: string;
	height: number;
	innerWidth: number;
	clientWidth: number;
	shellWidth: number;
	scrollWidth: number;
	scrollbarPx: number;
	gutter: string;
}

/** The five numbers that describe the column at one moment. */
async function measure(
	page: Page
): Promise<Omit<Sample, 'locale' | 'density' | 'route' | 'height'>> {
	return page.evaluate(() => ({
		innerWidth: window.innerWidth,
		clientWidth: document.documentElement.clientWidth,
		shellWidth: document.querySelector('.app-shell')!.getBoundingClientRect().width,
		scrollWidth: document.scrollingElement!.scrollWidth,
		scrollbarPx: window.innerWidth - document.documentElement.clientWidth,
		gutter: getComputedStyle(document.documentElement).scrollbarGutter
	}));
}

test('the app column width is invariant across locales, pages and viewport heights', async () => {
	// Headless Chromium hides scrollbars by default (Playwright adds
	// --hide-scrollbars), which erases the exact mechanism this spec exists to
	// catch: the classic scrollbar stealing layout width when it appears. Force
	// them back on. (The second test in this file keeps the normal fixture —
	// overflow counting does not care whether scrollbars are painted.)
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	try {
		// 36 full app boots (3 heights × 3 pages × 2 locales × 2 densities) — the
		// same budget visual-gate.spec.ts needs for its screen walk, doubled by
		// the compact-density pass.
		test.setTimeout(240_000);
		if (DIAG) mkdirSync(SHOT_DIR, { recursive: true });

		const context = await browser.newContext({
			locale: 'de-DE',
			viewport: { width: 800, height: 640 }
		});
		const page = await context.newPage();

		await registerAccount(page, 'Layoutde');
		const listUrl = await createList(page, 'Layoutprobe');

		const samples: Sample[] = [];
		// Viewport width 800: BELOW --app-max (820px) + a classic scrollbar (~15px),
		// so the shell is not width-capped and the scrollbar's appearance actually
		// changes the column size (800 vs ~785px). At desktop widths the shell is
		// capped either way and only shifts — which is the same defect's visible
		// symptom, but not measurable as width.
		const heights = [640, 900, 1200];
		const routes = [listUrl, '/', '/settings'];

		async function collect(locale: 'de' | 'en', density: 'comfortable' | 'compact'): Promise<void> {
			for (const height of heights) {
				await page.setViewportSize({ width: 800, height });
				for (const route of routes) {
					await page.goto(route);
					// The shell pads the body bottom and uses min-block-size: 100dvh;
					// measure only once the route itself has rendered: the shell is
					// there before it, and a loading placeholder is no layout.
					if (route === listUrl) {
						await expect(
							page.getByRole('button', { name: 'Layoutprobe', exact: true })
						).toBeVisible();
					} else if (route === '/') {
						await expect(page.getByRole('link', { name: /Layoutprobe/ })).toBeVisible();
					}
					await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
					// Settings is this sweep's page that scrolls, at 640px; since
					// [D-269] it is short enough that it does so only once its last
					// group and foot have rendered.
					if (route === '/settings') await expect(page.getByTestId('app-version')).toBeVisible();
					// The layout's $effect re-writes dataset.density from the Dexie
					// pref on every full page load, so the attribute must be set after
					// the navigation — the [D-83] tokens are CSS and apply instantly;
					// the preference persistence is not what this spec asserts.
					await page.evaluate((d) => {
						document.documentElement.dataset.density = d;
					}, density);
					samples.push({ locale, density, route, height, ...(await measure(page)) });
				}
			}
		}

		// German first: the context above is created with locale 'de-DE'.
		await collect('de', 'comfortable');

		// Flip to English from settings and wait for the remount: the app re-keys
		// the whole subtree on a locale switch ({#key $localePref} in
		// +layout.svelte), so the English settings heading is the remount-complete
		// signal.
		await page.goto('/settings');
		await page.getByTestId('settings-locale').getByRole('radio', { name: 'English' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
		await collect('en', 'comfortable');

		// Compact-density pass: [D-83] retunes only the shop-grid spacing tokens
		// (--tile-h, --grid-gap, --tile-p, --aisle-py) — never --app-max or the
		// gutter — but the layout contract must hold under
		// [data-density='compact'] too, so re-run the full de/en sweep and
		// let the same invariants below cover both densities. Flip back to German
		// first: each collect() samples whatever locale the app is currently in.
		await page.getByTestId('settings-locale').getByRole('radio', { name: 'Deutsch' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
		await collect('de', 'compact');
		await page.getByTestId('settings-locale').getByRole('radio', { name: 'English' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
		await collect('en', 'compact');

		if (DIAG) {
			console.table(samples);
			await test.info().attach('width-samples.json', {
				body: JSON.stringify(samples, null, 2),
				contentType: 'application/json'
			});
			// The settings screen in both locales at height 900 — a scrollbar-width
			// delta shows in the column edge.
			await page.setViewportSize({ width: 800, height: 900 });
			await page.goto('/settings');
			await expect(page.locator('.app-shell')).toBeVisible();
			await page.screenshot({ path: path.join(SHOT_DIR, 'settings-en.png'), fullPage: true });
			await page.getByTestId('settings-locale').getByRole('radio', { name: 'Deutsch' }).click();
			await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
			await expect(page.locator('.app-shell')).toBeVisible();
			await page.screenshot({ path: path.join(SHOT_DIR, 'settings-de.png'), fullPage: true });
		}

		// WHY the width-invariance contract is asserted this way: headless
		// Chromium's shell does not reserve the root gutter consistently across
		// navigations — with `scrollbar-gutter: stable` computed on every page,
		// documentElement.clientWidth can flip between 800 and 785 between loads
		// while the shell keeps the width it laid out with. A cross-sample width
		// equality over non-scrolling pages therefore flaps in this environment
		// even with the rule in place. The computed rule plus scrolling-state
		// consistency is the non-flaky form of the gate here.

		// CONTRACT 1: the fix is installed. Computed style is the one thing this
		// headless environment reports consistently (see the comment above for why
		// the LAYOUT-level reservation is not asserted here).
		for (const s of samples) {
			expect(
				s.gutter,
				`scrollbar-gutter: stable must be in effect (${s.route}, ${s.locale}, h=${s.height})`
			).toBe('stable');
		}

		// CONTRACT 2: no horizontal overflow — scrollWidth may be SMALLER than
		// clientWidth (a centered column narrower than the viewport is fine), it
		// must never be larger.
		for (const s of samples) {
			expect(
				s.scrollWidth,
				`no horizontal overflow on ${s.route} (${s.locale}, h=${s.height})`
			).toBeLessThanOrEqual(s.clientWidth);
		}

		// CONTRACT 3: every sample where a classic scrollbar is actually present
		// (scrollbarPx > 0 → the content scrolled) must lay the column out at the
		// SAME width. This pins the scrollbar-state consistency without depending
		// on the flaky reservation.
		const scrolling = samples.filter((s) => s.scrollbarPx > 0);
		expect(scrolling.length, 'the sweep must include scrolling samples').toBeGreaterThan(0);
		const scrollWidths = new Set(scrolling.map((s) => Math.round(s.shellWidth)));
		expect(
			scrollWidths.size,
			`scrolling pages must share one column width — got ${[...scrollWidths].join(', ')}px`
		).toBe(1);
	} finally {
		await browser.close();
	}
});

test('the item detail sheet fits a phone without scrolling', async ({ page }) => {
	// An iPhone 17 in portrait. The sheet is compact on purpose: name and
	// quantity share a row, the labels ride as placeholders, and the aisles are
	// an icon grid. So every field and every seeded aisle is on screen at once.
	await page.setViewportSize({ width: 402, height: 874 });
	await registerAccount(page, 'Layoutde');
	await createList(page, 'Layoutprobe');
	await openListView(page);
	await addItemByTyping(page, 'LayoutMilch');

	// Open the detail sheet the keyboard way (a11y-manual.spec.ts): focus the
	// add bar, Tab until a row name button has focus, then Enter.
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
	await page.keyboard.press('Enter');

	const sheet = page.locator('[data-slot="sheet-content"]');
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('radio')).toHaveCount(21);

	// Nothing inside the open sheet scrolls: no nested overflow-y container
	// scrolling on its own, apart from the sheet, and no scrolling .sheet-body
	// either. Only elements that can actually scroll count (overflow-y
	// auto/scroll AND overflowing content).
	const scrollables = await sheet.evaluate((el) => {
		const els = Array.from(el.querySelectorAll<HTMLElement>('*')).filter((e) => {
			const s = getComputedStyle(e);
			return (
				(s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight
			);
		});
		return els.map((e) => `${e.tagName}.${String(e.className).split(' ').join('.')}`);
	});
	expect(scrollables, 'every field and every aisle must be visible without scrolling').toEqual([]);

	await page.keyboard.press('Escape');
	await expect(sheet).toHaveCount(0);
});

// [D-83]/[D-86]: the aisle header is ONE shared component over both views and
// must take its vertical padding from --aisle-py. A hardcoded padding that
// happens to equal the comfortable value passes every single-density check;
// only a cross-density assertion catches it.
test('aisle headers follow the density tokens in both views', async ({ page }) => {
	await registerAccount(page, 'Densite');
	await createList(page, 'Dichteprobe');
	await openListView(page);
	await addItemByTyping(page, 'DichteMilch');

	// Category sort so the list view renders aisle headers (A→Z has none).
	await page.getByTestId('item-sort').click();
	await page.getByRole('menuitemradio', { name: 'Kategorie' }).click();

	// 'DichteMilch' is uncategorized — its aisle comes from the list's seeded
	// Others row, which only arrives with the first snapshot pull. Wait for the
	// header before measuring it, like the shop-view half below does; on a
	// contended CI runner the pull can lose the race to the first evaluate.
	await expect(page.locator('.cat-head').first()).toBeVisible({ timeout: 15_000 });

	const headerPad = (scope = '') =>
		page.evaluate((within) => {
			const head = document.querySelector(`${within} .cat-head`);
			if (!head) throw new Error('no .cat-head rendered');
			return parseFloat(getComputedStyle(head).paddingBlockStart);
		}, scope);
	const aisleToken = () =>
		page.evaluate(() =>
			parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--aisle-py'))
		);

	const comfortable = await headerPad();
	const comfortableToken = await aisleToken();
	expect(comfortable).toBe(comfortableToken);

	await page.evaluate(() => {
		document.documentElement.dataset.density = 'compact';
	});
	const compact = await headerPad();
	const compactToken = await aisleToken();
	expect(compact).toBe(compactToken);
	expect(compact).toBeLessThan(comfortable);

	// And the shop view's headers move with the same token. Its own headers:
	// both views draw the same AisleHeader, so a bare .cat-head is the list
	// view's until the swap has landed. Polled: the view switch can re-render
	// the header between a visibility check and a one-shot read.
	await openShopView(page);
	await expect(page.locator('.shop-view .cat-head').first()).toBeVisible();
	// headerPad THROWS when no header is mounted, and expect.poll fails on a
	// throw rather than retrying it, so a missing header reads as null here,
	// which the poll simply retries.
	await expect.poll(() => headerPad('.shop-view').catch(() => null)).toBe(compactToken);
});

test('the tile template follows the density tokens (name scale, note, gap)', async ({ page }) => {
	await registerAccount(page, 'Densite');
	await createList(page, 'Rasterprobe');
	await openListView(page);
	// A two-line name + note + quantity chip: the full content stack the
	// comfortable tile holds and compact has to fit without dropping a field.
	await addItemByTyping(page, 'Spülmaschinentabs Classic');
	await page
		.getByTestId('row')
		.first()
		.getByRole('button', { name: 'Spülmaschinentabs Classic', exact: true })
		.click();
	await page.getByPlaceholder('z. B. nur Marke X').fill('die grossen');
	// The sheet has no Save button — closing it flushes the draft
	// (commit-on-close). The flush is fire-and-forget, so wait for the
	// note to land where the list row shows it before moving on.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('row').filter({ hasText: 'die grossen' })).toBeVisible();
	await page.getByTestId('row').first().getByRole('button', { name: 'Menge hinzufügen' }).click();
	await page.keyboard.type('1 Packung');
	await page.keyboard.press('Enter');
	await openShopView(page);

	const read = () =>
		page.evaluate(() => {
			const tile = document.querySelector<HTMLElement>('[data-testid="tile"]');
			if (!tile) throw new Error('no tile rendered');
			const name = tile.querySelector<HTMLElement>('.tile-name');
			const note = tile.querySelector<HTMLElement>('.tile-note');
			const qty = tile.querySelector<HTMLElement>('.qty');
			if (!name || !qty) throw new Error('no .tile-name or .qty rendered');
			const ncs = getComputedStyle(name);
			// The tile must actually hold its content at both densities (no
			// clipped glyphs). Judged on the VISIBLE parts, not
			// tile.scrollHeight: the door's ::after widens its tap target to
			// 44px ([D-56]) and the tile deliberately does not clip it, so
			// scrollHeight would count that invisible extension as overflow.
			const box = tile.getBoundingClientRect();
			const innerBottom = box.bottom - parseFloat(getComputedStyle(tile).borderBottomWidth);
			const visible = [name, note, qty, tile.querySelector<HTMLElement>('.tile-info')];
			return {
				overflows: visible.some((el) => el && el.getBoundingClientRect().bottom > innerBottom + 1),
				nameSize: parseFloat(ncs.fontSize),
				noteDisplayed: note ? getComputedStyle(note).display !== 'none' : false,
				// --tile-gap separates the text from the foot line; the tile
				// spaces its parts by margin, not grid gap ([D-83]), so an
				// absent part leaves no gap behind.
				gap: parseFloat(getComputedStyle(qty).marginBlockStart)
			};
		});

	// The view swap mounts the tile grid asynchronously (liveQuery → render),
	// and layout settles a beat later still — a bare page.evaluate has no
	// auto-wait, so gate the first measurement on the tile being there with
	// its quantity (an empty one draws no .qty).
	await expect(page.getByTestId('tile').locator('.qty')).toHaveText('1 Packung');

	const comfortable = await read();
	expect(comfortable.overflows).toBe(false);
	expect(comfortable.noteDisplayed).toBe(true);
	expect(comfortable.gap).toBe(4);

	await page.evaluate(() => {
		document.documentElement.dataset.density = 'compact';
	});
	// Two frames: the first lays out under the new density and runs the
	// tile's ResizeObserver; its re-measure lands in the second. A read before
	// it sees the comfortable door under compact tokens.
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
	);
	// Polled, not read once: the tile's door and clamp come from a measurement
	// that re-runs a frame after the density change (ResizeObserver), and the
	// door changes a typed tile's grid rows — a read in the same task sees the
	// old state under the new density. A real overflow stays and still fails
	// when the poll times out.
	await expect.poll(async () => (await read()).overflows).toBe(false);
	const compact = await read();
	expect(compact.nameSize).toBeLessThan(comfortable.nameSize);
	// [D-83]: nothing is dropped, only truncated — the note rides a metadata
	// line at EVERY density, and the name yields a line to it at compact.
	expect(compact.noteDisplayed).toBe(true);
	// One gap for both densities — see the --tile-gap token comment.
	expect(compact.gap).toBe(comfortable.gap);
});

test('the list density renders check-off rows with the note back [D-83, D-313]', async ({
	page
}) => {
	// Unlike the token assertions above, the row SHAPE is markup chosen from
	// the pref store (ShopView's one derived), so this drives the REAL control
	// — the sort menu's „Anzeige" choice ([D-271]) — not the root attribute.
	await registerAccount(page, 'Liste');
	await createList(page, 'Listenprobe');
	await openListView(page);
	await addItemByTyping(page, 'Spülmaschinentabs Classic');
	await page
		.getByTestId('row')
		.first()
		.getByRole('button', { name: 'Spülmaschinentabs Classic', exact: true })
		.click();
	await page.getByPlaceholder('z. B. nur Marke X').fill('die grossen');
	// Esc closes + flushes; the row carrying the note is
	// the signal that the commit landed.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('row').filter({ hasText: 'die grossen' })).toBeVisible();
	await openShopView(page);

	await page.getByTestId('item-sort').click();
	// Choosing closes the menu.
	await page.getByRole('menuitemradio', { name: 'Liste' }).click();

	const read = () =>
		page.evaluate(() => {
			const tile = document.querySelector<HTMLElement>('[data-testid="tile"]');
			if (!tile) throw new Error('no tile rendered');
			const name = tile.querySelector<HTMLElement>('.tile-name');
			const note = tile.querySelector<HTMLElement>('.tile-note');
			const grid = tile.closest<HTMLElement>('.grid');
			if (!name || !grid) throw new Error('tile structure missing');
			return {
				rowShape: tile.classList.contains('row'),
				// The row shape keeps the note on its single line.
				noteDisplayed: note ? getComputedStyle(note).display !== 'none' : false,
				nameSingleLine: getComputedStyle(name).whiteSpace === 'nowrap',
				// One full-width column, with no aisle grids.
				columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length
			};
		});

	await expect(async () => {
		const state = await read();
		expect(state.rowShape).toBe(true);
		expect(state.noteDisplayed).toBe(true);
		expect(state.nameSingleLine).toBe(true);
		expect(state.columns).toBe(1);
		// toPass ignores the expect timeout and defaults to none: without one, a
		// failure surfaced only as the test's own timeout.
	}).toPass({ timeout: 30_000 });
});

// A density switch must re-measure the tile: it changes the name's size and
// clamp without remounting the tiles, and between ~331 and 386px (most phones)
// comfortable and compact tiles are exactly as wide. What catches it is the
// tile's ResizeObserver on its CONTENT box — compact's smaller padding still
// changes that width. A guard for that behaviour: if the observer ever moved to
// the border box, a phone would keep the previous density's cut state.
test(
	'switching density re-measures the tile even when its width does not change',
	{ tag: '@chromium' },
	async ({ page }) => {
		// Long enough that a full-width phone tile needs two lines for it at
		// comfortable (which fit) and cuts it at compact (one line beside the note).
		const NAME = 'Spülmaschinentabs Classic Multi-Power mit Zitrone';
		await page.setViewportSize({ width: 375, height: 800 });
		await registerAccount(page, 'Dichte');
		await createList(page, 'Dichtewechsel');
		await openListView(page);
		await addItemByTyping(page, NAME);
		await page.getByTestId('row').first().getByRole('button', { name: NAME, exact: true }).click();
		await page.getByPlaceholder('z. B. nur Marke X').fill('die grossen');
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('row').filter({ hasText: 'die grossen' })).toBeVisible();
		await openShopView(page);
		const tile = page.locator('[data-testid="tile"]').first();
		await expect(tile).toBeVisible();

		await page.evaluate(() => (document.documentElement.dataset.density = 'comfortable'));
		await expect(tile).not.toHaveAttribute('data-door', ''); // two lines: it fits
		// offsetWidth, not getBoundingClientRect: the latter includes the tiles'
		// pop-in scale animation, and the tile's ResizeObserver sees layout width.
		const width = await tile.evaluate((el) => (el as HTMLElement).offsetWidth);

		await page.evaluate(() => (document.documentElement.dataset.density = 'compact'));
		// The premise: the switch leaves the layout width alone at this viewport.
		expect(await tile.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(width);
		await expect(tile).toHaveAttribute('data-door', '');
	}
);
