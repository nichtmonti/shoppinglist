// §9.1 shop view: tile tap-to-check and the in-store sort order
// (category sort_order → name, Others last).
//
// Follows the harness pattern documented in
// src/lib/components/auth/auth-screen.svelte.test.ts: seed Dexie (fake-indexeddb)
// BEFORE render(), then await waitFor() since the liveQuery-backed stores in
// #lib/state/data.ts emit asynchronously.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '#lib/db.js';
import { t } from '#lib/i18n/index.js';
import { itemSort } from '#lib/state/prefs.js';
import {
	resetDb,
	makeItem,
	makeCategory,
	makeTemplate,
	putSynced,
	seedList,
	updateSynced
} from '#lib/test-kit/db.js';
import { DAY_MS, daysAgo, isoAgo } from '#lib/test-kit/time.js';
import ShopView from './ShopView.svelte';
import { openPhotoViewer } from './photo-lightbox';
import { historyBack, page } from '#lib/test-kit/app-state.svelte.js';

vi.mock('./photo-lightbox', () => ({ openPhotoViewer: vi.fn() }));

const LIST_ID = 'list-1';

/** The tile box around a check-off button ([D-83]: the tile is a box whose
 *  check-off is a button covering it, beside the door). */
const tileOf = (button: HTMLElement) => button.closest<HTMLElement>('[data-testid="tile"]')!;

describe('ShopView', () => {
	beforeEach(async () => {
		await resetDb();
	});

	// The truncated-name test stubs Element.prototype scroll dimensions
	// (happy-dom never lays out); restore before any later test sees them.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('groups tiles under aisle headers in aisle order, Others last, A→Z within an aisle', async () => {
		const produce = makeCategory({
			list: LIST_ID,
			slug: 'produce',
			name: 'Obst & Gemüse',
			icon: '🥦',
			color: 'green',
			sort_order: 1
		});
		const bakery = makeCategory({
			list: LIST_ID,
			slug: 'bakery',
			name: 'Brot & Backwaren',
			icon: '🥖',
			color: 'amber',
			sort_order: 2
		});
		const others = makeCategory({
			list: LIST_ID,
			slug: 'other',
			name: null,
			icon: '📦',
			color: 'gray',
			sort_order: 999
		});
		const templates = [
			makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse' } }),
			makeTemplate({ slug: 'bakery', name_i18n: { de: 'Brot & Backwaren' } }),
			makeTemplate({ slug: 'other', name_i18n: { de: 'Sonstiges' } })
		];
		const items = [
			makeItem({ list: LIST_ID, name: 'Zwiebeln', category_key: produce.id }),
			makeItem({ list: LIST_ID, name: 'Apfel', category_key: produce.id }),
			makeItem({ list: LIST_ID, name: 'Brot', category_key: bakery.id }),
			// null category_key falls into Others (§6.6 / groupByAisle).
			makeItem({ list: LIST_ID, name: 'Batterien', category_key: null })
		];
		await seedList({ listId: LIST_ID, items, categories: [produce, bakery, others], templates });

		render(ShopView, { props: { listId: LIST_ID } });

		const headers = await waitFor(() => {
			const found = screen.getAllByText(/Obst & Gemüse|Brot & Backwaren|Sonstiges/);
			expect(found.length).toBe(3);
			return found;
		});
		// Header order reflects aisle order: produce, bakery, then Others last.
		expect(headers.map((h) => h.textContent)).toEqual([
			'Obst & Gemüse',
			'Brot & Backwaren',
			'Sonstiges'
		]);

		// A→Z within the produce aisle: "Apfel" before "Zwiebeln".
		// Only the check-off buttons, not the per-tile info controls.
		const produceSection = headers[0].closest('section') as HTMLElement;
		const produceNames = within(produceSection)
			.getAllByRole('button')
			.filter((b) => b.classList.contains('tile-check'))
			.map((b) => b.getAttribute('aria-label'));
		expect(produceNames).toEqual(['Apfel, abhaken', 'Zwiebeln, abhaken']);

		// Others holds the null-category item.
		const othersSection = headers[2].closest('section') as HTMLElement;
		expect(within(othersSection).getByText('Batterien')).toBeDefined();
	});

	it('switches to one locale-collated A–Z grid, retaining check/restore and newest-first done order', async () => {
		const produce = makeCategory({ list: LIST_ID, name: 'Obst', sort_order: 1 });
		const bakery = makeCategory({ list: LIST_ID, name: 'Brot', sort_order: 2 });
		const others = makeCategory({ list: LIST_ID, slug: 'other', name: 'Sonstiges' });
		const now = Date.now();
		await seedList({
			listId: LIST_ID,
			categories: [produce, bakery, others],
			items: [
				makeItem({ list: LIST_ID, name: 'Zucker', category_key: produce.id }),
				makeItem({ list: LIST_ID, name: 'Apfel 10', category_key: bakery.id }),
				makeItem({ list: LIST_ID, name: 'Äpfel', category_key: bakery.id }),
				makeItem({ list: LIST_ID, name: 'Apfel 2', category_key: null }),
				makeItem({ list: LIST_ID, name: 'Entfernt', deleted_at: new Date(now).toISOString() }),
				makeItem({
					list: LIST_ID,
					name: 'Alt',
					checked: true,
					checked_at: isoAgo(DAY_MS, now)
				}),
				makeItem({
					list: LIST_ID,
					name: 'A zuerst gekauft',
					checked: true,
					checked_at: new Date(now - 2000).toISOString()
				}),
				makeItem({
					list: LIST_ID,
					name: 'Z zuletzt gekauft',
					checked: true,
					checked_at: new Date(now - 1000).toISOString()
				})
			]
		});
		render(ShopView, { listId: LIST_ID });
		await waitFor(() => expect(document.querySelectorAll('.cat-head')).toHaveLength(3));
		await itemSort.set('az');
		const activeNames = () =>
			screen
				.getAllByTestId('tile')
				.map((tile) => tile.querySelector('.tile-check')!.getAttribute('aria-label'));
		const ordered = ['Äpfel, abhaken', 'Apfel 2, abhaken', 'Apfel 10, abhaken', 'Zucker, abhaken'];
		await waitFor(() => {
			expect(activeNames()).toEqual(ordered);
			expect(document.querySelectorAll('.cat-head')).toHaveLength(0);
		});
		expect(screen.getAllByTestId('done-row').map((row) => row.getAttribute('aria-label'))).toEqual([
			'Z zuletzt gekauft, wieder auf die Liste',
			'A zuerst gekauft, wieder auf die Liste'
		]);

		await fireEvent.click(screen.getByRole('button', { name: 'Apfel 2, abhaken' }));
		await waitFor(() =>
			expect(activeNames()).toEqual(ordered.filter((name) => name !== 'Apfel 2, abhaken'))
		);
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Apfel 2, wieder auf die Liste' })
		);
		await waitFor(() => expect(activeNames()).toEqual(ordered));
		await itemSort.set('category');
		await waitFor(() => expect(document.querySelectorAll('.cat-head')).toHaveLength(3));
	});

	it('keeps the re-measure probe above every aisle and tile ([D-83])', async () => {
		// The tiles re-measure inside the probe's ResizeObserver notification,
		// where the browser delivers size changes only for boxes deeper than the
		// probe. A tile, or an aisle (watched for its containment, [D-89]), at
		// the probe's depth or above would be a ResizeObserver loop error.
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const items = ['Milch', 'Schokoladenriegel'].map((name) =>
			makeItem({ list: LIST_ID, name, category_key: cat.id })
		);
		await seedList({ listId: LIST_ID, items, categories: [cat] });
		await itemSort.set('category');

		render(ShopView, { props: { listId: LIST_ID } });
		await screen.findByRole('button', { name: 'Milch, abhaken' });

		const depth = (el: Element) => {
			let n = 0;
			for (let up = el.parentElement; up; up = up.parentElement) n++;
			return n;
		};
		const assertBelowProbe = () => {
			const probe = document.querySelector('.shop-probe');
			expect(probe).not.toBeNull();
			const tiles = document.querySelectorAll('[data-testid="tile"]');
			expect(tiles).toHaveLength(2);
			for (const el of [...document.querySelectorAll('.aisle'), ...tiles])
				expect(depth(el)).toBeGreaterThan(depth(probe!));
		};

		expect(document.querySelectorAll('.aisle')).toHaveLength(1);
		assertBelowProbe();

		await itemSort.set('az');
		await waitFor(() => expect(document.querySelector('.aisle')).toBeNull());
		assertBelowProbe();
		await itemSort.set('category');
	});

	it('tapping a tile checks the item off and moves it into the erledigt section', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const item = makeItem({ list: LIST_ID, name: 'Milch', category_key: cat.id });
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const tile = await screen.findByRole('button', { name: 'Milch, abhaken' });
		await fireEvent.click(tile);

		await waitFor(async () => {
			const row = await db.items.get(item.id);
			expect(row?.checked).toBe(true);
			expect(row?.checked_at).not.toBeNull();
		});

		// The observable outcome: it left the active tile grid and is now the
		// restore-labelled row in the erledigt section.
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Milch, abhaken' })).toBeNull();
			expect(screen.getByRole('button', { name: 'Milch, wieder auf die Liste' })).toBeDefined();
		});
	});

	// WCAG 2.4.3: a tile ticked from the keyboard leaves the grid; its focus goes
	// to the tile that takes its place, not back to the top of the page.
	it('hands the focus to the next tile when a focused tile is checked off', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const items = ['Apfel', 'Birne', 'Kiwi'].map((name) =>
			makeItem({ list: LIST_ID, name, category_key: cat.id })
		);
		await seedList({ listId: LIST_ID, items, categories: [cat] });
		render(ShopView, { props: { listId: LIST_ID } });

		const birne = await screen.findByRole('button', { name: 'Birne, abhaken' });
		birne.focus();
		await fireEvent.click(birne, { detail: 0 });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Kiwi, abhaken' }));

		// The last tile hands it back to the one before.
		const kiwi = screen.getByRole('button', { name: 'Kiwi, abhaken' });
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Birne, abhaken' })).toBeNull()
		);
		await fireEvent.click(kiwi, { detail: 0 });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Apfel, abhaken' }));
	});

	it('hands the focus on when a focused done row is put back', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const now = new Date().toISOString();
		const items = ['Apfel', 'Birne'].map((name) =>
			makeItem({ list: LIST_ID, name, category_key: cat.id, checked: true, checked_at: now })
		);
		await seedList({ listId: LIST_ID, items, categories: [cat] });
		render(ShopView, { props: { listId: LIST_ID } });

		const rows = await screen.findAllByTestId('done-row');
		rows[0].focus();
		await fireEvent.click(rows[0], { detail: 0 });
		expect(document.activeElement).toBe(rows[1]);
	});

	it('ignores a hold: the tile has exactly one gesture, and it is the tap', async () => {
		// No hold gesture ([D-83]): it would share the gesture with the
		// platform's own text-select/context menu, so holding a tile would fire
		// both. A press that is held and then released is just a tap, and a tap
		// checks the item off.
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const item = makeItem({
			list: LIST_ID,
			name: 'Milch',
			note: 'nur halbfett',
			category_key: cat.id
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const tile = await screen.findByRole('button', {
			name: t('shop_check_tile', { name: 'Milch, nur halbfett' })
		});

		vi.useFakeTimers();
		try {
			await fireEvent.pointerDown(tile);
			await vi.advanceTimersByTimeAsync(600);
		} finally {
			vi.useRealTimers();
		}
		expect(screen.queryByRole('dialog')).toBeNull();

		await fireEvent.pointerUp(tile);
		await fireEvent.click(tile);
		await waitFor(async () => {
			expect((await db.items.get(item.id))?.checked).toBe(true);
		});
	});

	it('lists the erledigt section newest-checked first and restores on tap', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const older = makeItem({
			list: LIST_ID,
			name: 'Älter',
			category_key: cat.id,
			checked: true,
			checked_at: new Date(Date.now() - 60_000).toISOString()
		});
		const newer = makeItem({
			list: LIST_ID,
			name: 'Neuer',
			category_key: cat.id,
			checked: true,
			checked_at: new Date(Date.now() - 1_000).toISOString()
		});
		await seedList({ listId: LIST_ID, items: [older, newer], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const doneList = await waitFor(() => {
			const el = document.querySelector('.done-list');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		const rows = within(doneList).getAllByRole('button');
		expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
			'Neuer, wieder auf die Liste',
			'Älter, wieder auf die Liste'
		]);

		await fireEvent.click(rows[0]);

		await waitFor(async () => {
			const row = await db.items.get(newer.id);
			expect(row?.checked).toBe(false);
			expect(row?.checked_at).toBeNull();
		});
		// Restored: it is back in the active tile grid.
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Neuer, abhaken' })).toBeDefined();
		});
	});

	it('renders a photo tile for an item with image_url, and a name-prominent tile with no emoji otherwise', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const photoItem = makeItem({
			list: LIST_ID,
			name: 'Sonnencreme',
			category_key: cat.id,
			image_url: 'https://images.example/sonnencreme.jpg'
		});
		const plainItem = makeItem({ list: LIST_ID, name: 'Kartoffeln', category_key: cat.id });
		await seedList({ listId: LIST_ID, items: [photoItem, plainItem], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const photoTile = tileOf(await screen.findByRole('button', { name: 'Sonnencreme, abhaken' }));
		const img = photoTile.querySelector('img');
		expect(img).not.toBeNull();
		expect(img?.getAttribute('src')).toBe('https://images.example/sonnencreme.jpg');

		const plainTile = tileOf(screen.getByRole('button', { name: 'Kartoffeln, abhaken' }));
		expect(plainTile.querySelector('img')).toBeNull();
		// No per-tile category emoji (the aisle header carries it, [D-37]): the
		// category's icon string must not appear inside the tile itself.
		expect(within(plainTile).queryByText(cat.icon)).toBeNull();
		expect(within(plainTile).getByText('Kartoffeln')).toBeDefined();
	});

	it('keeps a scan product in the photo-variant layout when its photo is missing or failed [D-83]', async () => {
		// The product-tile invariant: image_url OR barcode ⇒ photo layout, name
		// on the scrim at the foot (the door at its foot-start, [D-83]). A failed
		// photo stays in this layout: in the centered plain layout the 2-line
		// name would run under the door's frosted circle. The plain layout is
		// exclusively typed items, which never carry a door.
		const cat = makeCategory({
			list: LIST_ID,
			slug: 'dairy',
			name: 'Milchprodukte',
			sort_order: 1
		});
		const brokenPhoto = makeItem({
			list: LIST_ID,
			name: 'Bio Vollmilch 3,5% 1 l',
			category_key: cat.id,
			image_url: '/icons/does-not-exist.png',
			barcode: '4008400402222'
		});
		const barcodeOnly = makeItem({
			list: LIST_ID,
			name: 'Haferflocken',
			category_key: cat.id,
			barcode: '4104420032033'
		});
		await seedList({ listId: LIST_ID, items: [brokenPhoto, barcodeOnly], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const tile = tileOf(
			await screen.findByRole('button', { name: 'Bio Vollmilch 3,5% 1 l, abhaken' })
		);
		// The img is in the DOM until its error event fires; happy-dom never loads
		// images, so dispatch it like the browser would.
		await fireEvent.error(tile.querySelector('img')!);

		await waitFor(() => {
			// Photo FAILED: the img is gone, but the tile keeps the photo variant
			// — dark placeholder instead of the centered plain fallback.
			expect(tile.classList.contains('photo')).toBe(true);
			expect(tile.querySelector('img')).toBeNull();
			expect(tile.querySelector('.tile-photo-fallback')).not.toBeNull();
			expect(tile.querySelector('.scrim')).not.toBeNull();
		});

		// Barcode-ONLY (never had a picture): photo variant from the start.
		const only = tileOf(screen.getByRole('button', { name: 'Haferflocken, abhaken' }));
		expect(only.classList.contains('photo')).toBe(true);
		expect(only.querySelector('.tile-photo-fallback')).not.toBeNull();
		expect(only.querySelector('img')).toBeNull();

		// And the typed control stays plain, doorless.
		const typed = makeItem({ list: LIST_ID, name: 'Kartoffeln', category_key: cat.id });
		await putSynced([typed]);
		await waitFor(() => {
			const t = tileOf(screen.getByRole('button', { name: 'Kartoffeln, abhaken' }));
			expect(t.classList.contains('photo')).toBe(false);
			expect(t.querySelector('.tile-info')).toBeNull();
		});
	});

	it('renders the list density as check-off rows with the note and no photo [D-83, D-313]', async () => {
		// The pref is seeded BEFORE render (the live store emits async), so the
		// first settled render is already rows.
		const cat = makeCategory({ list: LIST_ID, slug: 'dairy', name: 'Molkerei', sort_order: 1 });
		const typed = makeItem({
			list: LIST_ID,
			name: 'Milch',
			quantity: '1 l',
			note: 'nur halbfett',
			category_key: cat.id
		});
		const pictured = makeItem({
			list: LIST_ID,
			name: 'Haferdrink',
			image_url: 'https://example.test/hafer.jpg',
			category_key: cat.id
		});
		await seedList({ listId: LIST_ID, items: [typed, pictured], categories: [cat] });
		await db.meta.put({ key: 'ui_density', value: 'list' });

		render(ShopView, { props: { listId: LIST_ID } });

		const row = tileOf(
			await screen.findByRole('button', { name: 'Milch, 1 l, nur halbfett, Molkerei, abhaken' })
		);
		await waitFor(() => expect(row.getAttribute('data-shape')).toBe('row'));

		// The note renders at every density when present.
		expect(row.querySelector('.tile-note')?.textContent).toContain('nur halbfett');
		// One-line name: the truncation is the tile template's `[data-shape='row']
		// .tile-name` rule ([D-143]), which happy-dom does not load, so the
		// markup's side of it is the shape it states and the clamp it drops.
		expect(row.querySelector('.tile-name')?.classList.contains('line-clamp-2')).toBe(false);
		// A fitting typed row carries no door ([D-83]); happy-dom does not lay
		// out, so the measurement reads "fits".
		expect(row.hasAttribute('data-door')).toBe(false);

		// A row shows its photo as a thumbnail in the icon's place, so every
		// name starts at the same edge, and the thumbnail is the door: nothing
		// sits at the row's end ([D-331]).
		const photoRow = tileOf(screen.getByRole('button', { name: 'Haferdrink, Molkerei, abhaken' }));
		expect(photoRow.querySelector('.tile-media, .scrim, .tile-info')).toBeNull();
		const lead = within(photoRow).getByRole('button', {
			name: t('shop_product_info', { name: 'Haferdrink' })
		});
		expect(lead.querySelector('img.tile-thumb')?.getAttribute('src')).toBe(pictured.image_url);
		expect(lead.querySelector('.tile-badge')).not.toBeNull();
		// A row with no door keeps a plain icon, which a tap passes through.
		expect(row.querySelector('.tile-lead')?.tagName).toBe('SPAN');

		// The lead opens the sheet and leaves the item unticked.
		await fireEvent.click(lead);
		await screen.findByRole('dialog', { name: t('shop_product_details') });
		expect((await db.items.get(pictured.id))?.checked).toBe(false);
	});

	it('renders the list density as rows in aisle order, each led by its category [D-313]', async () => {
		const dairy = makeCategory({ list: LIST_ID, slug: 'dairy', name: 'Molkerei', sort_order: 1 });
		const veg = makeCategory({ list: LIST_ID, slug: 'veg', name: 'Gemüse', sort_order: 2 });
		const items = [
			makeItem({ list: LIST_ID, name: 'Äpfel', category_key: veg.id }),
			makeItem({ list: LIST_ID, name: 'Milch', category_key: dairy.id }),
			makeItem({ list: LIST_ID, name: 'Butter', category_key: dairy.id })
		];
		await seedList({ listId: LIST_ID, items, categories: [dairy, veg] });
		await db.meta.put({ key: 'ui_density', value: 'list' });

		render(ShopView, { props: { listId: LIST_ID } });

		// No header names the aisle, so the check button does.
		const butter = tileOf(await screen.findByRole('button', { name: 'Butter, Molkerei, abhaken' }));
		await waitFor(() => expect(butter.hasAttribute('data-marked')).toBe(true));
		expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
		expect(butter.getAttribute('data-shape')).toBe('row');
		expect(butter.querySelector('.tile-cat')).not.toBeNull();

		// One grid in aisle order, A–Z within; a run starts at each new aisle.
		const cells = [...document.querySelectorAll<HTMLElement>('.shop-grid.marked > .tile-wrap')];
		expect(cells.map((cell) => cell.querySelector('.tile-name')?.textContent)).toEqual([
			'Butter',
			'Milch',
			'Äpfel'
		]);
		expect(cells.map((cell) => cell.hasAttribute('data-run-start'))).toEqual([true, false, true]);
	});

	it('seats the note at compact and never renders a "Zuletzt" badge on a shop tile', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'dairy', name: 'Molkerei', sort_order: 1 });
		const noted = makeItem({
			list: LIST_ID,
			name: 'Milch',
			quantity: '1 l',
			note: 'nur halbfett',
			// Bought recently — must still not badge in the shop: 'Zuletzt' is
			// planning-only.
			last_bought_at: daysAgo(2),
			category_key: cat.id
		});
		const bare = makeItem({ list: LIST_ID, name: 'Kartoffeln', category_key: cat.id });
		await seedList({ listId: LIST_ID, items: [noted, bare], categories: [cat] });
		await db.meta.put({ key: 'ui_density', value: 'compact' });

		render(ShopView, { props: { listId: LIST_ID } });

		const tile = tileOf(
			await screen.findByRole('button', { name: 'Milch, 1 l, nur halbfett, abhaken' })
		);
		await waitFor(() => {
			// The note seats at compact too.
			expect(tile.querySelector('.tile-note')?.textContent).toContain('nur halbfett');
		});
		// The shop tile never renders the recency badge — it lives on the
		// planning row (ListRow) only.
		expect(tile.querySelector('.tile-bought')).toBeNull();
		expect(document.querySelector('.tile-bought')).toBeNull();

		// An item with no note renders no metadata line, so the name keeps its
		// two-line clamp (:has(.tile-meta) is false in app.css).
		const bareTile = tileOf(screen.getByRole('button', { name: 'Kartoffeln, abhaken' }));
		expect(bareTile.querySelector('.tile-meta')).toBeNull();
	});

	it('shows the "no items at all" empty state for a fresh list', async () => {
		await seedList({ listId: LIST_ID, items: [], categories: [] });

		render(ShopView, { props: { listId: LIST_ID } });

		await waitFor(() => {
			expect(screen.getByText('Noch nichts auf der Liste')).toBeDefined();
		});
		// Names the tab that exists (Einkaufen/Bearbeiten) — no "Liste" alias
		// ([D-101]).
		expect(screen.getByText('Wechsle zu „Bearbeiten“, um Artikel hinzuzufügen.')).toBeDefined();
	});

	it('shows the "alles erledigt" empty state once every item is checked', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const item = makeItem({
			list: LIST_ID,
			name: 'Milch',
			category_key: cat.id,
			checked: true,
			checked_at: new Date().toISOString()
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		await waitFor(() => {
			expect(screen.getByText('Alles erledigt')).toBeDefined();
		});
		// The erledigt section stays below it for restores.
		expect(screen.getByRole('button', { name: 'Milch, wieder auf die Liste' })).toBeDefined();
	});
});

describe('ShopView — product details sheet', () => {
	// A sibling describe of the main ShopView block, so its beforeEach does not
	// carry over — reset the shared Dexie DB here to keep these tests isolated.
	beforeEach(async () => {
		await resetDb();
	});

	it('opens a read-only product sheet from the tile info button without checking the item', async () => {
		const cat = makeCategory({
			list: LIST_ID,
			slug: 'personal_care',
			name: 'Pflege',
			sort_order: 1
		});
		const item = makeItem({
			list: LIST_ID,
			name: 'Sonnencreme',
			category_key: cat.id,
			barcode: '4005808307870',
			image_url: 'https://images.openbeautyfacts.org/sonnencreme.jpg',
			quantity: '200 ml',
			note: 'wasserfest'
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		// No sheet open before the info tap.
		expect(screen.queryByRole('dialog')).toBeNull();

		// The info control overlays the tile but is a SIBLING, not a child of the
		// check button — so tapping it must open the sheet without toggling the item.
		const info = await screen.findByRole('button', {
			name: t('shop_product_info', { name: 'Sonnencreme' })
		});
		await fireEvent.click(info);

		const dialog = await screen.findByRole('dialog', {
			name: t('shop_product_details')
		});
		expect(dialog).toBeDefined();

		// Product photo + OFF attribution (alt="" → decorative, so query directly).
		const img = dialog.querySelector('img');
		expect(img).not.toBeNull();
		expect(img?.getAttribute('src')).toBe(item.image_url);
		// The credit Open Food Facts' terms ask for: the source and the photo's licence, linked.
		expect(
			within(dialog)
				.getByRole('link', { name: t('scan_attribution') })
				.getAttribute('href')
		).toBe('https://world.openfoodfacts.org');
		expect(within(dialog).getByRole('link', { name: 'CC BY-SA 3.0' }).getAttribute('href')).toBe(
			'https://creativecommons.org/licenses/by-sa/3.0/'
		);

		// The photo is the fullscreen-viewer door ([D-94]): a labelled button
		// around the image, not the image itself.
		expect(
			within(dialog).getByRole('button', {
				name: t('shop_photo_enlarge', { name: 'Sonnencreme' })
			})
		).toBeDefined();

		// Name, labelled barcode, quantity, note — all read-only.
		expect(within(dialog).getByText('Sonnencreme')).toBeDefined();
		expect(within(dialog).getByText(`${t('common_barcode')}: 4005808307870`)).toBeDefined();
		expect(within(dialog).getByText(new RegExp(`${t('common_quantity')}.*200 ml`))).toBeDefined();
		expect(within(dialog).getByText('wasserfest')).toBeDefined();
		// The aisle it is shelved in (§9.1, [D-213]).
		expect(within(dialog).getByTestId('detail-category').textContent).toContain('Pflege');

		// The info tap did not check the item off: the tile is still in the active grid.
		expect(
			screen.getByRole('button', {
				name: t('shop_check_tile', { name: 'Sonnencreme, 200 ml, wasserfest' })
			})
		).toBeDefined();
		const stored = await db.items.get(item.id);
		expect(stored?.checked).toBe(false);
	});

	it('unmounts the detail sheet behind the fullscreen viewer and brings it back on close [D-94]', async () => {
		const cat = makeCategory({
			list: LIST_ID,
			slug: 'personal_care',
			name: 'Pflege',
			sort_order: 1
		});
		const item = makeItem({
			list: LIST_ID,
			name: 'Sonnencreme',
			category_key: cat.id,
			barcode: '4005808307870',
			image_url: 'https://images.openbeautyfacts.org/sonnencreme.jpg'
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });
		let hooks: { onopen?: (close: () => void) => void; onclose?: () => void } = {};
		vi.mocked(openPhotoViewer).mockImplementation((_src, _label, h) => {
			hooks = h ?? {};
			return Promise.resolve(true);
		});

		render(ShopView, { props: { listId: LIST_ID } });

		const info = await screen.findByRole('button', {
			name: t('shop_product_info', { name: 'Sonnencreme' })
		});
		await fireEvent.click(info);
		const dialog = await screen.findByRole('dialog', {
			name: t('shop_product_details')
		});
		expect(dialog).toBeDefined();

		// Tapping the photo hands the screen to the viewer: the sheet
		// unmounts (a single focus-trapped layer at a time) while the item
		// stays put for the return trip.
		await fireEvent.click(
			within(dialog).getByRole('button', {
				name: t('shop_photo_enlarge', { name: 'Sonnencreme' })
			})
		);
		expect(vi.mocked(openPhotoViewer)).toHaveBeenCalledWith(item.image_url, 'Sonnencreme', {
			onopen: expect.any(Function),
			onclose: expect.any(Function)
		});
		const closeViewer = vi.fn(() => hooks.onclose?.());
		hooks.onopen?.(closeViewer);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		// The viewer has a back entry of its own in place of the sheet's
		// ([D-230]): back closes it and leaves the screen where it is.
		await waitFor(() => expect(page.state.overlays ?? []).toHaveLength(1));
		historyBack();
		await waitFor(() => expect(closeViewer).toHaveBeenCalledTimes(1));

		const returned = await screen.findByRole('dialog', {
			name: t('shop_product_details')
		});
		expect(within(returned).getByText('Sonnencreme')).toBeDefined();
	});

	it('keeps the door off a fitting typed tile and grants it exactly while the name is cut ([D-83])', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const item = makeItem({ list: LIST_ID, name: 'Zwiebeln', category_key: cat.id });
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		await screen.findByRole('button', { name: t('shop_check_tile', { name: 'Zwiebeln' }) });
		// A hand-typed item whose text fits carries no door: its sheet only
		// repeats what the tile already shows ([D-83]'s corner budget; the door
		// was unconditional for a while and is conditional again).
		// happy-dom never lays out — scroll/client dimensions are 0 — so the
		// measurement reports "fits".
		expect(
			screen.queryByRole('button', { name: t('shop_product_info', { name: 'Zwiebeln' }) })
		).toBeNull();
	});

	it('gives a photo tile no door when nothing is hidden, and a barcode one always ([D-83])', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'dairy_eggs', name: 'Milch', sort_order: 1 });
		const photoOnly = makeItem({
			list: LIST_ID,
			name: 'Milch',
			category_key: cat.id,
			image_url: 'https://images.openfoodfacts.org/milch.jpg'
		});
		const scanned = makeItem({
			list: LIST_ID,
			name: 'Butter',
			category_key: cat.id,
			barcode: '4000000000001'
		});
		await seedList({ listId: LIST_ID, items: [photoOnly, scanned], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		await screen.findByRole('button', { name: t('shop_check_tile', { name: 'Milch' }) });
		// The photo is on the tile and the name fits (happy-dom measures "fits"):
		// nothing for the door to reveal.
		expect(
			screen.queryByRole('button', { name: t('shop_product_info', { name: 'Milch' }) })
		).toBeNull();
		// The barcode's number lives only in the sheet.
		expect(
			screen.getByRole('button', { name: t('shop_product_info', { name: 'Butter' }) })
		).toBeDefined();
	});

	it('grants a typed tile its door while its name is cut, and flips that name start-aligned', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		const item = makeItem({
			list: LIST_ID,
			name: 'Haselnusscreme mit Vollmilchgeschmack',
			category_key: cat.id
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		// happy-dom does not lay out, so the clamp is forced the only way the
		// component can see it: the square shape reads scrollHeight vs
		// clientHeight on the name span. Stubbed BEFORE render so the mount
		// measurement itself sees the cut.
		// Spied where the environment defines them: happy-dom on Element.prototype,
		// happy-dom on HTMLElement.prototype.
		const owner = (prop: string): object => {
			let proto: object | null = window.HTMLElement.prototype;
			while (proto && !Object.prototype.hasOwnProperty.call(proto, prop))
				proto = Object.getPrototypeOf(proto) as object | null;
			if (!proto) throw new Error(`no prototype defines ${prop}`);
			return proto;
		};
		const scrollHeight = vi.spyOn(owner('scrollHeight') as Element, 'scrollHeight', 'get');
		const clientHeight = vi.spyOn(owner('clientHeight') as Element, 'clientHeight', 'get');
		scrollHeight.mockReturnValue(200);
		clientHeight.mockReturnValue(40);

		render(ShopView, { props: { listId: LIST_ID } });

		const name = tileOf(
			await screen.findByRole('button', {
				name: t('shop_check_tile', { name: 'Haselnusscreme mit Vollmilchgeschmack' })
			})
		).querySelector('.tile-name') as HTMLElement;
		// A cut name uses the whole line (.clamped →
		// text-align: start) instead of centring the cut fragment.
		await waitFor(() => {
			expect(name.classList.contains('clamped')).toBe(true);
		});
		// …and the cut text has its reader: the door the measurement earned.
		expect(
			screen.queryByRole('button', {
				name: t('shop_product_info', { name: 'Haselnusscreme mit Vollmilchgeschmack' })
			})
		).not.toBeNull();
	});

	// The sheet shows the row as it is now: an edit elsewhere reaches it, and a
	// row that leaves the grid under it (a co-shopper checked it) closes it.
	it('follows the live row, and closes when the row leaves the grid', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'personal_care', name: 'Pflege' });
		const item = makeItem({
			list: LIST_ID,
			name: 'Sonnencreme',
			category_key: cat.id,
			barcode: '4005808307870',
			note: 'wasserfest'
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });
		await fireEvent.click(
			await screen.findByRole('button', { name: t('shop_product_info', { name: 'Sonnencreme' }) })
		);
		const dialog = await screen.findByRole('dialog', { name: t('shop_product_details') });

		await updateSynced(item.id, { note: 'LSF 50' });
		expect(await within(dialog).findByText('LSF 50')).toBeDefined();

		await updateSynced(item.id, { checked: true, checked_at: new Date().toISOString() });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});
});

describe('ShopView — what a shopper hears and taps ([D-213])', () => {
	beforeEach(async () => {
		await resetDb();
	});

	it('names a done row with its quantity, so the restore says what comes back', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'dairy', name: 'Molkerei', sort_order: 1 });
		const item = makeItem({
			list: LIST_ID,
			name: 'Milch',
			quantity: '1 l',
			checked: true,
			checked_at: new Date().toISOString(),
			category_key: cat.id
		});
		await seedList({ listId: LIST_ID, items: [item], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		expect(
			await screen.findByRole('button', { name: t('shop_restore_tile', { name: 'Milch, 1 l' }) })
		).toBeDefined();
	});

	it('draws no glyph on a grid placeholder, where the name runs', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'dairy', name: 'Molkerei', sort_order: 1 });
		const scan = makeItem({
			list: LIST_ID,
			name: 'Bergkäse',
			barcode: '4000000000001',
			category_key: cat.id
		});
		await seedList({ listId: LIST_ID, items: [scan], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const tile = tileOf(await screen.findByRole('button', { name: 'Bergkäse, abhaken' }));
		const fallback = tile.querySelector('.tile-photo-fallback');
		expect(fallback).not.toBeNull();
		expect(fallback?.querySelector('svg')).toBeNull();
	});

	it('drops a second tap on the spot a tile just left, and only that one', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'dairy', name: 'Molkerei', sort_order: 1 });
		const [a, b, c] = ['Butter', 'Eier', 'Milch'].map((name) =>
			makeItem({ list: LIST_ID, name, category_key: cat.id })
		);
		await seedList({ listId: LIST_ID, items: [a, b, c], categories: [cat] });

		render(ShopView, { props: { listId: LIST_ID } });

		const tap = { detail: 1, clientX: 80, clientY: 120 };
		await fireEvent.click(await screen.findByRole('button', { name: 'Butter, abhaken' }), tap);
		await waitFor(async () => expect((await db.items.get(a.id))?.checked).toBe(true));

		// The neighbour that slid into the slot, tapped at the same spot at once.
		await fireEvent.click(screen.getByRole('button', { name: 'Eier, abhaken' }), tap);
		// A deliberate tap elsewhere is never held back.
		await fireEvent.click(screen.getByRole('button', { name: 'Milch, abhaken' }), {
			detail: 1,
			clientX: 260,
			clientY: 120
		});
		await waitFor(async () => expect((await db.items.get(c.id))?.checked).toBe(true));
		expect((await db.items.get(b.id))?.checked).toBe(false);
	});

	// [D-293] The done rows slide up the same way when one is put back.
	it('drops a second tap on the done row that slid into a restored one', async () => {
		const at = (ms: number) => new Date(Date.now() - ms).toISOString();
		const butter = makeItem({ list: LIST_ID, name: 'Butter', checked: true, checked_at: at(1000) });
		const eier = makeItem({ list: LIST_ID, name: 'Eier', checked: true, checked_at: at(2000) });
		await seedList({ listId: LIST_ID, items: [butter, eier] });

		render(ShopView, { props: { listId: LIST_ID } });

		const tap = { detail: 1, clientX: 80, clientY: 400 };
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Butter, wieder auf die Liste' }),
			tap
		);
		await waitFor(async () => expect((await db.items.get(butter.id))?.checked).toBe(false));
		await fireEvent.click(screen.getByRole('button', { name: 'Eier, wieder auf die Liste' }), tap);

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await db.items.get(eier.id))?.checked).toBe(true);
	});
});
