import { expect, test, type Page } from '../tests/fixtures';
import {
	addItemByTyping,
	createList,
	openListView,
	openShopView,
	registerAccount
} from '../tests/helpers';
import { expandDoneSection, installEffectSpies, reachSurface, walkSurface } from './walk';
import { guardTest, watchPage } from '../diagnose';

// Architectural regression gate for "dead controls" — a control that is
// visible and enabled but where pressing it changes NOTHING observable.
//
// The class of bug it guards (§9.1, [D-124]): a visible, enabled control
// that silently does nothing — e.g. a view switch on a sub-route that writes a
// preference no view on screen applies, or a segment rendered as active whose
// tap bits-ui's ToggleGroup treats as a deselect (which
// #lib/components/ui/segmented/segmented.svelte swallows).
//
// THE METHOD: for each named surface below, enumerate every visible+enabled
// clickable control that is actually rendered at the surface's default,
// freshly-established state (native buttons/links + role=radio/switch/
// checkbox/menuitem/menuitemradio/tab). For each one: re-establish the
// surface from scratch, take a STABLE "before" signature of the page, click
// exactly that one control, and assert something in the signature changed —
// the URL, the rendered DOM, the focused element, a download/file-chooser/
// clipboard/share/window.open call. Fail loudly, naming the surface and the
// control's accessible name, if nothing did.
//
// WHY ONLY THE DEFAULT-STATE SNAPSHOT: the control list for a surface is
// captured ONCE, from its closed/default rendering, before anything is
// clicked — never by recursively opening what a click reveals. This is not
// just a scope simplification, it is what keeps the walk safe: every
// destructively-confirmed action in this app (leave list, delete account,
// remove a passkey, remove an item) sits behind a sheet/dialog that does not
// exist in the DOM until its own trigger is clicked, so a walk that never
// clicks twice into the same subtree can never reach a confirm button. The
// controls that do NOT follow that pattern are named individually in
// walk.ts's NEVER_CLICK sets.
//
// The engine lives in walk.ts. ANTI-FLAKE: `stableSignature` waits until two 250ms-apart reads agree before
// treating a signature as "before" (a relative-time tick or a sync banner
// settling must not be mistaken for the click's own effect, and must not mask
// a genuinely dead control either); `observedChange` then polls for up to 2.5s
// rather than sleeping a fixed amount. The surface is re-established — back
// on its route if a control navigated away, overlays closed, and where needed
// a menu/sheet re-opened — before EVERY single control, so one control's side
// effect can never leak into the next control's baseline.

// Serial, and cheap about navigation: a page.goto() is a full SPA boot worth a
// dozen-odd API calls, and the per-IP request budget this run shares with
// itself is PocketBase's default /api/ rule (arch.config.ts says why this spec
// runs in its own single-worker harness).
test.describe.configure({ mode: 'serial', retries: 0 });

// ---- one fixture for every surface ----------------------------------------
//
// Serial mode lets the surfaces share ONE browser context: one registration and
// two lists for the whole file, rather than one account per test, keeps the
// run inside PocketBase's default per-IP budget (/api/, 300/10s — POST
// /api/lists has no app-level limiter of its own, §10).
let page: Page;
let listPath: string;

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	page = await context.newPage();
	watchPage(page);
	await installEffectSpies(page);
	await registerAccount(page, 'Deadctrl');

	// Two lists: the home surface is specified as the POPULATED home, and a
	// single-list home hides the ▾ switcher's "other lists" rows.
	const listUrl = await createList(page, 'Wocheneinkauf');
	// reachSurface() compares pathnames, so surfaces are addressed by path
	// rather than by the absolute URL createList() returns.
	listPath = new URL(listUrl).pathname;
	await page.goto('/');
	await createList(page, 'Büroeinkauf');

	// Items live on the first list: three active plus one checked, so the shop
	// view has tiles AND an "Erledigt" section, and the list view has rows.
	await page.goto(listUrl);
	await openListView(page);
	await addItemByTyping(page, 'Kaffee');
	await addItemByTyping(page, 'Milch');
	await addItemByTyping(page, 'Brot');
	await openShopView(page);
	await page.locator('[data-testid="tile"]', { hasText: 'Kaffee' }).click();
	await expect(page.getByTestId('done-head')).toBeVisible();
});

// The shared page is not a fixture, so the failure diagnosis ([D-247]) is
// wired here: a failed or timed-out test, once it has ended, writes what the
// page was doing to its page-diagnosis.md.
let finishGuard: (() => Promise<void>) | null = null;
test.beforeEach(({}, testInfo) => {
	finishGuard = guardTest(page, testInfo);
});
test.afterEach(async () => {
	await finishGuard?.();
	finishGuard = null;
});

test.afterAll(async () => {
	await page.context().close();
});

/** The home on its default face. reachSurface() does not reload a path it is
 *  already on, and arranging ([D-90]) is component state on `/`, so a walk
 *  that pressed "Reihenfolge ändern" (or an arrow) leaves the next one in
 *  arrange mode unless it is closed here. */
async function reachHome(): Promise<void> {
	await reachSurface(page, '/');
	const done = page.getByRole('button', { name: 'Fertig' });
	if (await done.isVisible()) await done.click();
	await expect(page.getByTestId('list-sort')).toBeVisible();
}

/** Arrange mode's rows, top to bottom, by name. */
function arrangedNames(): Promise<string[]> {
	return page
		.locator('.arrange-row')
		.evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label') ?? ''));
}

/** The arrangement once it has stopped moving: two reads 300ms apart agree. */
async function settledNames(): Promise<string[]> {
	let current = await arrangedNames();
	await expect
		.poll(async () => {
			const previous = current;
			// eslint-disable-next-line playwright/no-wait-for-timeout -- two reads apart: the order has settled when they agree
			await page.waitForTimeout(300);
			current = await arrangedNames();
			return current.join('|') === previous.join('|');
		})
		.toBe(true);
	return current;
}

/** Puts an arrangement back in `order`, using its own ↑ buttons. Every arrow
 *  the walk presses persists a move, so without this an arrow enumerated as
 *  enabled sits at an end — disabled — by the time its turn comes. The first
 *  call records the order to restore. Retried whole: the previous control's
 *  move can land after a read that looked settled, undoing a pass that
 *  thought there was nothing to do. */
async function restoreArrangement(order: string[]): Promise<void> {
	if (order.length === 0) {
		order.push(...(await settledNames()));
		return;
	}
	await expect(async () => {
		const current = await settledNames();
		for (let i = 0; i < order.length; i++) {
			let at = current.indexOf(order[i]);
			// Only the row whose handle was tapped shows arrows ([D-237]); it
			// stays selected while it moves.
			const handle = page.getByRole('button', { name: `${order[i]} verschieben` });
			if (at > i && (await handle.getAttribute('aria-pressed')) !== 'true') await handle.click();
			while (at > i) {
				await page.getByRole('button', { name: `${order[i]} nach oben` }).click();
				[current[at - 1], current[at]] = [current[at], current[at - 1]];
				at--;
			}
		}
		expect(await settledNames()).toEqual(order);
	}).toPass({ timeout: 30_000 });
}

test('dead-controls: home (populated, ≥2 lists)', async () => {
	test.setTimeout(240_000);

	// The header (settings gear, sort trigger) + every card's own
	// open-button and ⋯ trigger + the footer's create/join/import actions —
	// everything rendered on home with nothing pre-opened. Gated on the sort
	// trigger rather than the (locale-dependent) heading text.
	await walkSurface(page, 'home', async () => {
		await reachHome();
		await expect(page.getByTestId('list-sort')).toBeVisible();
		return page.locator('body');
	});

	// The ordering menu's own radio items (list-sort).
	await walkSurface(page, 'home sort menu', async () => {
		await reachHome();
		await page.getByTestId('list-sort').click();
		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible();
		return menu;
	});

	// The first card's ⋯ menu — this is where "Backup exportieren"
	// and "Umbenennen (mein Name)" live, not on the card itself.
	await walkSurface(page, 'home card ⋯ menu', async () => {
		await reachHome();
		await page.locator('[aria-label^="Aktionen für"]').first().click();
		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible();
		return menu;
	});

	// [D-90] The arrange mode behind the sort menu: every arrow and "Fertig".
	// The drag handle is a role=button span, outside this walk's selector; a tap
	// on it shows its row's arrows ([D-237]), so the setup taps the second row's
	// to give the walk a ↑ and a ↓ to press.
	const homeOrder: string[] = [];
	await walkSurface(page, 'home arrange mode', async () => {
		await reachHome();
		await page.getByTestId('list-sort').click();
		await page.getByRole('menuitem', { name: 'Reihenfolge ändern' }).click();
		await expect(page.getByRole('heading', { name: 'Listen anordnen' })).toBeVisible();
		await restoreArrangement(homeOrder);
		const second = page.getByRole('button', { name: `${homeOrder[1]} verschieben` });
		if ((await second.getAttribute('aria-pressed')) !== 'true') await second.click();
		return page.locator('body');
	});
});

test('dead-controls: shop view', async () => {
	test.setTimeout(240_000);

	await walkSurface(page, 'shop view', async () => {
		await reachSurface(page, listPath);
		await openShopView(page);
		await expandDoneSection(page);
		// NOT a tile: walking the tiles themselves (each one toggles checked)
		// eventually checks every item off, and the empty "Alles erledigt"
		// state then renders no tiles at all — a readiness check tied to tile
		// presence would then fail every LATER control's re-establish, even
		// header controls that have nothing to do with tiles. `.shop-view` is
		// rendered in every state (loading/empty/all-done/normal).
		await expect(page.locator('.shop-view')).toBeVisible();
		return page.locator('body');
	});

	await walkSurface(page, 'shop view item-sort menu', async () => {
		await reachSurface(page, listPath);
		await openShopView(page);
		await page.getByTestId('item-sort').click();
		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible();
		return menu;
	});
});

test('dead-controls: list (edit) view', async () => {
	test.setTimeout(240_000);

	await walkSurface(page, 'list view', async () => {
		await reachSurface(page, listPath);
		await openListView(page);
		// Not tied to a row existing, for the same reason the shop-view
		// surface is not tied to a tile.
		await expect(page.getByTestId('item-sort')).toBeVisible();
		return page.locator('body');
	});

	await walkSurface(page, 'list view item-sort menu', async () => {
		await reachSurface(page, listPath);
		await openListView(page);
		await page.getByTestId('item-sort').click();
		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible();
		return menu;
	});
});

test('dead-controls: categories', async () => {
	test.setTimeout(240_000);

	await walkSurface(page, 'categories', async () => {
		await reachSurface(page, `${listPath}/categories`);
		// Its "Reihenfolge ändern" leaves the page arranging ([D-90]).
		const done = page.getByRole('button', { name: 'Fertig' });
		if (await done.isVisible()) await done.click();
		await expect(
			page.getByRole('heading', { level: 1, name: 'Kategorien bearbeiten' })
		).toBeVisible();
		// Each row's hide button names its category, so the walk presses every
		// one; put back what the last press hid, or the rows (and "Reihenfolge
		// ändern", which needs two) would be gone for every later control.
		const restore = page.getByRole('button', { name: 'Wiederherstellen' });
		while ((await restore.count()) > 0) {
			const before = await restore.count();
			await restore.first().click();
			await expect(restore).toHaveCount(before - 1);
		}
		return page.locator('body');
	});

	// [D-90] Its arrange mode: the arrows and "Fertig" (the handle, as on
	// home, is a drag and not walked).
	const categoryOrder: string[] = [];
	await walkSurface(page, 'categories arrange mode', async () => {
		await reachSurface(page, `${listPath}/categories`);
		// Already arranging when the previous control was an arrow.
		if (!(await page.locator('.arrange-list').isVisible())) {
			await page.getByRole('button', { name: 'Reihenfolge ändern' }).click();
		}
		await expect(page.locator('.arrange-list')).toBeVisible();
		await restoreArrangement(categoryOrder);
		return page.locator('body');
	});
});

test('dead-controls: settings', async () => {
	test.setTimeout(240_000);

	await walkSurface(page, 'settings', async () => {
		await reachSurface(page, '/settings');
		await expect(page).toHaveURL(/\/settings$/);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		// This surface's own LocaleToggle switches the account to English when
		// its turn comes up. Every OTHER control here is relocated by its
		// GERMAN accessible name, so once English has been tried it would stay
		// switched and every later "missing on re-establish" would really mean
		// "renamed by the last control". Force it back, deterministically.
		// BOUNDED, deliberately. locator.getAttribute() auto-waits for its
		// element and the harness sets no action timeout, so on a page that
		// drifted away from /settings it would wait out the whole test timeout
		// with nothing naming the cause. Waiting for the control with an
		// explicit timeout first makes a drift fail in seconds and say so.
		const deRadio = page.getByTestId('settings-locale-de');
		await expect(deRadio, 'settings: the locale toggle never appeared').toBeVisible({
			timeout: 15_000
		});
		if ((await deRadio.getAttribute('aria-checked', { timeout: 5_000 })) !== 'true') {
			await deRadio.click();
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		}
		return page.locator('body');
	});
});

test('dead-controls: list ⋮ settings sheet', async () => {
	test.setTimeout(240_000);

	await walkSurface(page, 'list settings sheet', async () => {
		await reachSurface(page, listPath);
		await page.getByTestId('list-menu').click();
		const sheet = page.locator('[data-vaul-drawer-direction="bottom"]');
		await expect(sheet).toBeVisible();
		return sheet;
	});
});

// [D-254] the import screen, both steps. The review is opened the way a share
// opens it, with a fresh load every time: "Text bearbeiten" leaves it for the
// paste step on the same path, which reachSurface() would not undo. Its
// confirmation makes a new list, which no surface after this one counts.
test('dead-controls: import (paste)', async () => {
	test.setTimeout(120_000);

	await walkSurface(page, 'import paste', async () => {
		await reachSurface(page, '/import');
		await expect(page.getByLabel('Liste als Text')).toBeVisible();
		return page.locator('body');
	});
});

test('dead-controls: import review', async () => {
	test.setTimeout(120_000);

	await walkSurface(page, 'import review', async () => {
		await page.goto(`/import?text=${encodeURIComponent('Arch-Import\n\n[Obst]\nÄpfel\nBirnen')}`);
		await expect(page.getByRole('checkbox', { name: 'Birnen' })).toBeVisible({ timeout: 15_000 });
		return page.locator('body');
	});
});

// LAST, deliberately: this is the one surface whose fixture installs a fake
// clock to end the checked item's trip ([D-18]), and the clock stays
// installed on the shared page. Running it last keeps every other surface on
// real time — the relative "zuletzt benutzt vor N Sekunden" strings that the
// settings walk reads would otherwise be frozen or jumped.
test('dead-controls: previous items', async () => {
	test.setTimeout(240_000);

	// Pin the view before enumerating: earlier surfaces' walks have been
	// clicking the view toggle, and the sort menu holds the density only while
	// shopping ([D-271]), so the surface would depend on which segment some
	// previous test happened to click last.
	await page.goto(listPath);
	await openShopView(page);
	await page.clock.install({ time: Date.now() });
	await page.clock.fastForward(25 * 3600 * 1000);
	// RESUME, which previous-items.spec.ts does not need to do. fastForward
	// leaves the faked clock PAUSED, and Playwright's actionability check calls
	// an element "stable" only after two consecutive animation frames agree — so
	// under a paused clock a visible, enabled control never becomes clickable
	// and every click waits out its timeout. The product spec clicks a handful
	// of times and gets away with it; a walk over every control on the screen
	// does not. Resuming keeps the date 25h ahead (which is the point — it puts
	// the checked item's trip behind it, [D-18]) while letting time flow
	// normally again.
	await page.clock.resume();
	await page.reload();
	await expect(page.getByText('Frühere Artikel')).toBeVisible();

	await walkSurface(page, 'previous items', async () => {
		await reachSurface(page, `${listPath}/previous`);
		await expect(page).toHaveURL(/\/previous$/);
		// And the membership has loaded: the bar names the list under the
		// screen's title once it has ([D-323]).
		await expect(page.getByRole('heading', { level: 1, name: 'Frühere Artikel' })).toBeVisible();
		await expect(page.getByText('Wocheneinkauf', { exact: true })).toBeVisible();
		return page.locator('body');
	});

	await walkSurface(page, 'previous items sort menu', async () => {
		await reachSurface(page, `${listPath}/previous`);
		await page.getByTestId('item-sort').click();
		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible();
		return menu;
	});

	// A sub-screen has no view to choose ([D-323]): the switch, whose segments
	// once rendered checked here and swallowed the tap, is not on it at all.
	await page.goto(`${listPath}/previous`);
	await expect(page.getByRole('heading', { level: 1, name: 'Frühere Artikel' })).toBeVisible();
	await expect(page.getByTestId('view-toggle-shop')).toHaveCount(0);
});
