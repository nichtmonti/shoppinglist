import { expect, test } from './fixtures';
import { addItemByTyping, createList, openListView, registerAccount } from './helpers';

// The add bar pins AND the aisle headers remain visible while scrolling a
// category-sorted list of ≥20 items across ≥3 aisles. `sticky top-0` sits on
// .addwrap, not .addbar (a sticky element cannot out-travel its containing
// block, and a wrapper exactly the bar's height would give it no room), and
// both views' aisle headers are offset to `top-[var(--addbar-h)]` — 60px
// under the list view's pinned bar, the 0px :root default everywhere else.
// Nothing else covers it: the unit/component suites are happy-dom (no layout at
// all) and the other E2E specs never scroll a grouped list, so the pin could
// regress — or the headers slide under the bar — with every other test green.
//
// The second half ([D-131]) rides this fixture because its checks need exactly
// it: 20+ rows across 3 aisles in category mode, at scroll 0. While the
// typeahead is open the list must not be reachable (a thumb aiming at the last
// suggestion and landing low would open an unrelated item's detail sheet), and
// the aisle headers — which stick at exactly the dropdown's top edge — must not
// paint over the first suggestion. Both are pure hit-testing, which is why they
// are here and not in happy-dom, and both select by stable product markup rather
// than a class that exists only for the guard, so they fail on the behaviour
// itself ([D-127]).
test('category-sorted list: the bar pins, the headers stick below it, and the open typeahead owns the screen', async ({
	page
}) => {
	await registerAccount(page, 'Pia');
	await createList(page, 'Großeinkauf');
	await openListView(page);

	// The dictionary mirror arrives with the first sync drain — wait for proof
	// it is there (a seeded suggestion) before anything below depends on it,
	// or items silently land in Sonstiges (same guard as auto-category.spec).
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill('Schokolad');
	await expect(page.locator('[data-ta-name="Schokolade"]')).toBeVisible({ timeout: 15_000 });
	await input.fill('');

	// Three anchors into three distinct seeded aisles via the suggestion click
	// the locale spec uses. The .ta-cat wait is the race guard: clicking before
	// the chip resolves would silently categorize into Others.
	const anchors: [prefix: string, name: string, aisle: string][] = [
		['Gur', 'Gurke', 'Obst & Gemüse'],
		['Bro', 'Brot', 'Brot & Backwaren'],
		['Mil', 'Milch', 'Milch & Kühlregal']
	];
	for (const [prefix, name, aisle] of anchors) {
		await input.fill(prefix);
		await expect(page.locator(`[data-ta-name="${name}"] .ta-cat`)).toHaveText(aisle);
		await page.locator(`[data-ta-name="${name}"]`).click();
		await expect(page.locator('[data-testid="row"]', { hasText: name })).toBeVisible();
	}

	// Bulk to ≥20 rows: plain typed adds of further seeded names (the a11y
	// spec's fill+Enter pattern — Enter takes the top dictionary suggestion,
	// which carries its own aisle). Which aisle each lands in is irrelevant
	// here; the anchors already guarantee the spread.
	for (const name of [
		'Tomate',
		'Kartoffel',
		'Zwiebel',
		'Karotte',
		'Knoblauch',
		'Brötchen',
		'Croissant',
		'Baguette',
		'Toastbrot',
		'Mischbrot',
		'Roggenbrot',
		'Butter',
		'Joghurt',
		'Käse',
		'Quark',
		'Sahne',
		'Frischkäse',
		'Mozzarella'
	]) {
		await addItemByTyping(page, name);
	}

	// By-category sort (the shared header menu) is what renders the headers.
	await page.getByTestId('item-sort').click();
	await page.getByRole('menuitemradio', { name: 'Kategorie' }).click();
	await expect(page.locator('.cat-head').first()).toBeVisible();
	// Poll, don't snapshot: the 18 adds above are fire-and-forget by design
	// (fill+Enter with no per-row wait), so the last commits can still be in
	// flight — and draining through the sync loop — when a single-shot count
	// runs. Polling waits the backlog out instead of racing it.
	await expect
		.poll(async () => page.locator('.cat-head').count(), { timeout: 15_000 })
		.toBeGreaterThanOrEqual(3);
	await expect
		.poll(async () => page.locator('[data-testid="row"]').count(), { timeout: 15_000 })
		.toBeGreaterThanOrEqual(20);

	// ---- [D-131]: the open typeahead owns the screen -----------------------
	//
	// Runs here, at scroll 0 with the first aisle header at its resting
	// position — which is the dropdown's top edge — and before the scroll
	// section below, which needs the typeahead closed again.
	const dropdown = page.locator('[role="listbox"]');
	await input.fill('Mil');
	await expect(dropdown).toBeVisible();
	await expect(page.locator('[data-ta-name="Milch"]')).toBeVisible();

	// (a) No aisle header may own the first suggestion's pixels. `.addwrap` is
	// `sticky` WITH a z-index, so it is a stacking context and the dropdown's
	// own z-index is local to it — the stacking context has to sit above the
	// headers, or a header paints over the first suggestion and takes its tap.
	const owner = await page.evaluate(() => {
		const first = document
			.querySelector('[role="listbox"] [role="option"]')!
			.getBoundingClientRect();
		const hit = document.elementFromPoint(
			Math.round(first.left + first.width / 2),
			Math.round(first.top + first.height / 2)
		);
		return {
			inDropdown: !!hit?.closest('[role="listbox"]'),
			inHeader: !!hit?.closest('.cat-head')
		};
	});
	expect(owner.inHeader, 'an aisle header is painted over the first suggestion').toBe(false);
	expect(owner.inDropdown).toBe(true);

	// (b) The near miss, measured rather than guessed: the row whose own box
	// sits closest below the dropdown's foot is what a thumb aiming at the last
	// suggestion overshoots into. It must not be the topmost element there.
	const rowsBefore = await page.locator('[data-testid="row"]').count();
	const target = await page.evaluate(() => {
		const foot = document.querySelector('[role="listbox"]')!.getBoundingClientRect().bottom;
		const r = Array.from(document.querySelectorAll('[data-testid="row"]'))
			.map((el) => el.getBoundingClientRect())
			.filter((box) => box.top >= foot)
			.sort((a, b) => a.top - b.top)[0];
		// Named, because the alternative is a TypeError two lines down that says
		// nothing: no row below the dropdown means the fixture or the viewport
		// changed, not that the guard regressed.
		if (!r) throw new Error('no list row sits below the open dropdown — fixture too short?');
		const x = Math.round(r.left + r.width / 4);
		const y = Math.round(r.top + r.height / 2);
		const hit = document.elementFromPoint(x, y);
		return { x, y, rowOnTop: !!hit?.closest('[data-testid="row"]') };
	});
	// The stronger of the two: what the point BELONGS to, not merely what this
	// click happened to do. A row still topmost there is one stray tap from the
	// bug whatever this tap does.
	expect(target.rowOnTop, 'a list row is still taking taps under the open typeahead').toBe(false);

	await page.mouse.click(target.x, target.y);

	// Dismissed, and the tap went nowhere else: no detail sheet, no new row,
	// and the typed text survives the near miss.
	await expect(dropdown).toHaveCount(0);
	await expect(page.locator('[data-vaul-drawer-direction="bottom"]')).toHaveCount(0);
	await expect(input).toHaveValue('Mil');
	await expect(page.locator('[data-testid="row"]')).toHaveCount(rowsBefore);

	// Back to the resting bar for the scroll measurement below.
	await input.fill('');
	await expect(dropdown).toHaveCount(0);

	// Scroll to the middle and measure. Three candidate offsets, because one
	// fixed offset can land exactly on an aisle boundary — the outgoing header
	// just unstuck, the next not yet at the pin — which is boundary luck, not
	// a regression. A genuinely broken pin yields no stuck header at ANY
	// offset, so the loop cannot mask a real failure.
	interface Snapshot {
		barTop: number;
		barFoot: number;
		vh: number;
		stuckTop: number;
		stuckHeads: number;
		visibleHeads: number;
	}
	let snap: Snapshot | undefined;
	for (const fraction of [0.45, 0.6, 0.3]) {
		snap = await page.evaluate<Snapshot, number>((f) => {
			const max = document.documentElement.scrollHeight - window.innerHeight;
			// 'instant': the app's own smooth-scroll helpers pass a JS behavior
			// argument CSS cannot override, so this must too — a smooth scroll
			// would animate past these synchronous rect reads.
			window.scrollTo({ top: Math.round(max * f), behavior: 'instant' });
			const barTop = document.querySelector('.addwrap')?.getBoundingClientRect().top;
			const barFoot =
				document.querySelector('.addbar')?.getBoundingClientRect().bottom ?? Number.NaN;
			const vh = window.innerHeight;
			const heads = Array.from(document.querySelectorAll('.cat-head')).map((h) => {
				const r = h.getBoundingClientRect();
				return { top: r.top, bottom: r.bottom, height: r.height };
			});
			const stuck = heads.filter(
				(h) => h.height > 0 && h.top >= barFoot - 1 && h.top <= barFoot + 1 && h.bottom <= vh
			);
			return {
				barTop: barTop ?? Number.NaN,
				barFoot,
				vh,
				// Stuck at the pin: within ±1px of the measured bar foot
				// (--addbar-h tracks it via ResizeObserver), below the bar's
				// foot, fully painted inside the viewport.
				stuckTop: stuck[0]?.top ?? Number.NaN,
				stuckHeads: stuck.length,
				visibleHeads: heads.filter((h) => h.height > 0 && h.bottom > 0 && h.top < vh).length
			};
		}, fraction);
		if (snap.stuckHeads > 0) break;
	}

	// (a) The bar is pinned at the viewport top. It also starts the page
	// there, so this is only meaningful mid-scroll — which is where we measure.
	expect(
		Math.abs(snap!.barTop),
		'the add bar must pin at the viewport top while scrolled'
	).toBeLessThanOrEqual(1);
	// The bar must have real height, and the stuck headers must sit exactly at
	// its measured foot — the coupling the sticky offset relies on (--addbar-h tracks the
	// bar via ResizeObserver), asserted against the measurement rather than a
	// hardcoded 60px token the real bar legitimately exceeds.
	expect(snap!.barFoot, 'the pinned bar must have real height').toBeGreaterThanOrEqual(50);
	expect(
		Math.abs(snap!.stuckTop - snap!.barFoot),
		'aisle headers must stick exactly at the measured bar foot'
	).toBeLessThanOrEqual(1);
	// (b) Some aisle header sticks at the bar's foot (measured ±1), i.e. BELOW
	// the pinned bar — not at 0, not underneath it.
	expect(snap!.stuckHeads, 'an aisle header must stick below the pinned bar').toBeGreaterThan(0);
	// (c) Headers are not swallowed: at least one is painted in the viewport.
	expect(snap!.visibleHeads, 'aisle headers must remain visible').toBeGreaterThan(0);
});

// [D-132] On an iPhone, a tap on a suggestion must pick it and not open the
// detail sheet of the item behind it. bits-ui selects on pointerup, which
// empties the query and unmounts the dropdown AND its scrim before the tap's
// click is dispatched — and a touch click is hit-tested where the finger was,
// so it lands on whatever is under it now. bits-ui defers to that click for
// touch, EXCEPT when its user-agent sniff says iOS, so desktop Chrome never
// takes that branch. Hence an iPhone UA and a touch-capable page, tapped with
// `touchscreen` — not CDP's synthesizeTapGesture, after which headless
// Chromium dispatches no click at all, so it could show neither the
// fall-through nor the app's guard (which commits on that click).
test.describe('as an iPhone', () => {
	test.use({
		hasTouch: true,
		userAgent:
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
	});

	test('a tap on a suggestion picks it, and never reaches the row behind it', async ({ page }) => {
		await registerAccount(page, 'Tapi');
		await createList(page, 'Tapprobe');
		await openListView(page);
		const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
		const dropdown = page.locator('[role="listbox"]');
		// Enough rows that the open dropdown floats over some of them.
		for (const name of ['Tomate', 'Kartoffel', 'Zwiebel', 'Butter', 'Joghurt', 'Käse', 'Quark']) {
			await addItemByTyping(page, name);
		}
		await expect(page.locator('[data-testid="row"]')).toHaveCount(7, { timeout: 15_000 });
		const rowsBeforeTap = await page.locator('[data-testid="row"]').count();

		// A name not on the list, so the pick adds a row rather than jumping to one.
		// The dictionary mirror arrives with the first sync drain, hence the wait.
		await input.fill('Schokolad');
		await expect(page.locator('[data-ta-name="Schokolade"]')).toBeVisible({ timeout: 15_000 });

		// Tap the option that sits over a list row — the one a fall-through click
		// would reach — rather than trusting the layout to put one under the first.
		const tap = await page.evaluate(() => {
			const rows = Array.from(document.querySelectorAll('[data-testid="row"]')).map((el) =>
				el.getBoundingClientRect()
			);
			for (const opt of Array.from(document.querySelectorAll('[role="listbox"] [role="option"]'))) {
				const r = opt.getBoundingClientRect();
				const x = Math.round(r.left + r.width / 4);
				const y = Math.round(r.top + r.height / 2);
				if (rows.some((b) => y > b.top && y < b.bottom && x > b.left && x < b.right)) {
					return { x, y, label: opt.getAttribute('data-label') ?? '' };
				}
			}
			throw new Error('no suggestion sits over a list row — fixture or viewport changed?');
		});
		await page.touchscreen.tap(tap.x, tap.y);

		// The pick happened, and nothing behind it did.
		await expect(dropdown).toHaveCount(0);
		await expect(page.locator('[data-testid="row"]')).toHaveCount(rowsBeforeTap + 1);
		await expect(page.locator('[data-testid="row"]', { hasText: tap.label })).toBeVisible();
		// A fall-through click opens the sheet a beat after the pick; give it room
		// to appear so a pass is a real absence, not a race won.
		await page.waitForTimeout(500);
		await expect(
			page.locator('[data-vaul-drawer-direction="bottom"]'),
			'the tap on a suggestion fell through and opened the detail sheet of the row behind it'
		).toHaveCount(0);
	});
});
