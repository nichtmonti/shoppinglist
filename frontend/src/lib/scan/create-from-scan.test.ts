// §9.2 step 3 coverage: category-slug → this list's category-row resolution,
// and the create/dedup pipeline against a real (fake-indexeddb-backed) Dexie
// instance via the actual #lib/actions/items.addItem — never a bare db.items
// write (per the app's one-mutation-path rule).
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/db.js';
import { makeCategory, makeItem, resetDb, seedList } from '#lib/test-kit/db.js';
import { createItemFromScan, resolveCategoryKey } from './create-from-scan';
import type { ResolvedProduct } from './resolve';

const LIST = 'list-1';

function product(overrides: Partial<ResolvedProduct> = {}): ResolvedProduct {
	return {
		name: 'Nutella',
		name_de: null,
		name_en: null,
		image_url: 'https://images.example/nutella.jpg',
		category_slug: 'pantry',
		fromCache: false,
		...overrides
	};
}

describe('resolveCategoryKey', () => {
	it('returns null (→ Others) when the product has no mapped slug', () => {
		expect(resolveCategoryKey(null, [])).toBeNull();
	});

	it("returns null when this list has no category with that slug (a different list's aisles)", () => {
		const categories = [makeCategory({ list: LIST, slug: 'produce' })];
		expect(resolveCategoryKey('pantry', categories)).toBeNull();
	});

	it("resolves to this list's category row id for a matching slug", () => {
		const pantry = makeCategory({ list: LIST, slug: 'pantry' });
		expect(resolveCategoryKey('pantry', [pantry])).toBe(pantry.id);
	});

	it('ignores a tombstoned category row with a matching slug', () => {
		const pantry = makeCategory({
			list: LIST,
			slug: 'pantry',
			deleted_at: new Date().toISOString()
		});
		expect(resolveCategoryKey('pantry', [pantry])).toBeNull();
	});
});

describe('createItemFromScan', () => {
	beforeEach(async () => {
		await resetDb();
	});

	// [D-266] The photo shows at once, as the barcode's stamp; the op sends the
	// barcode only, since the server stamps the photo from it.
	it('creates an item carrying barcode, image_url, and the mapped category_key', async () => {
		const pantry = makeCategory({ list: LIST, slug: 'pantry' });
		await seedList({ listId: LIST, categories: [pantry] });

		const result = await createItemFromScan(LIST, '3017620422003', product(), [], [pantry]);

		expect(result.created).toBe(true);
		const row = await db.items.get(result.itemId);
		expect(row).toMatchObject({
			name: 'Nutella',
			barcode: '3017620422003',
			image_url: 'https://images.example/nutella.jpg',
			category_key: pantry.id
		});
		const [op] = await db.pending_ops.where('record_id').equals(result.itemId).toArray();
		expect(op.changed).toMatchObject({ barcode: '3017620422003' });
		expect(op.changed).not.toHaveProperty('image_url');
	});

	// [D-21]: the item carries every localized name the lookup returned.
	it('creates the item carrying the product names in each language', async () => {
		await seedList({ listId: LIST });

		const result = await createItemFromScan(
			LIST,
			'3017620422003',
			product({ name_de: 'Nuss-Nougat-Creme', name_en: 'Hazelnut spread' }),
			[],
			[]
		);

		const row = await db.items.get(result.itemId);
		expect(row).toMatchObject({
			name: 'Nutella',
			name_de: 'Nuss-Nougat-Creme',
			name_en: 'Hazelnut spread'
		});
	});

	it("name-dedup: a typed item matching the product's German name is reused", async () => {
		const existing = makeItem({ list: LIST, name: 'Nuss-Nougat-Creme', barcode: null });
		await seedList({ listId: LIST, items: [existing] });

		const result = await createItemFromScan(
			LIST,
			'3017620422003',
			product({ name_de: 'Nuss-Nougat-Creme' }),
			[existing],
			[]
		);

		expect(result).toEqual({ itemId: existing.id, created: false });
	});

	it('null category_key (→ Others) when the product maps to no slug this list has', async () => {
		await seedList({ listId: LIST });

		const result = await createItemFromScan(LIST, '123', product({ category_slug: null }), [], []);

		const row = await db.items.get(result.itemId);
		expect(row?.category_key).toBeNull();
	});

	it('scan-dedup: an existing item with the same barcode is reused, nothing created', async () => {
		const existing = makeItem({ list: LIST, name: 'Nutella (old)', barcode: '3017620422003' });
		await seedList({ listId: LIST, items: [existing] });
		const before = await db.items.count();

		const result = await createItemFromScan(LIST, '3017620422003', product(), [existing], []);

		expect(result.created).toBe(false);
		expect(result.itemId).toBe(existing.id);
		expect(await db.items.count()).toBe(before);
	});

	it('name-dedup: a resolved product name matching an existing (unscanned) item is reused', async () => {
		const existing = makeItem({ list: LIST, name: 'Nutella', barcode: null });
		await seedList({ listId: LIST, items: [existing] });
		const before = await db.items.count();

		const result = await createItemFromScan(
			LIST,
			'3017620422003',
			product({ name: 'Nutella' }),
			[existing],
			[]
		);

		expect(result.created).toBe(false);
		expect(result.itemId).toBe(existing.id);
		expect(await db.items.count()).toBe(before);
		// [D-266] The typed item takes the scan's barcode, and its photo shows at
		// once; the op sends the barcode only.
		expect(await db.items.get(existing.id)).toMatchObject({
			barcode: '3017620422003',
			image_url: 'https://images.example/nutella.jpg'
		});
		const [op] = await db.pending_ops.where('record_id').equals(existing.id).toArray();
		expect(op.changed).toEqual({ barcode: '3017620422003' });
	});

	it('name-dedup: an item with a barcode of its own keeps it', async () => {
		const existing = makeItem({ list: LIST, name: 'Nutella', barcode: '4000417025005' });
		await seedList({ listId: LIST, items: [existing] });

		await createItemFromScan(LIST, '3017620422003', product({ name: 'Nutella' }), [existing], []);

		expect((await db.items.get(existing.id))?.barcode).toBe('4000417025005');
		expect(await db.pending_ops.count()).toBe(0);
	});

	it('a tombstoned item that was NEVER bought is NOT treated as a dedup match', async () => {
		// No last_bought_at ⇒ no §6.10 history entry to collide with, so the
		// removed row really is gone and the scan inserts fresh ([D-18]).
		const gone = makeItem({
			list: LIST,
			name: 'Nutella',
			barcode: '3017620422003',
			deleted_at: new Date().toISOString()
		});
		await seedList({ listId: LIST, items: [gone] });

		const result = await createItemFromScan(LIST, '3017620422003', product(), [gone], []);

		expect(result.created).toBe(true);
		expect(result.itemId).not.toBe(gone.id);
	});

	it('a LIVING row wins over a remembered tombstone with the same barcode', async () => {
		// Two same-name/barcode rows can coexist after a concurrent insert (§8.3).
		// Jumping to the row that is actually on the list is right; restoring the
		// tombstone as well would put a second copy on it ([D-18]). The tombstone
		// is listed FIRST here so position cannot be what decides it.
		const remembered = makeItem({
			list: LIST,
			name: 'Nutella',
			barcode: '3017620422003',
			last_bought_at: '2026-09-08T10:00:00.000Z',
			deleted_at: new Date().toISOString()
		});
		const live = makeItem({ list: LIST, name: 'Nutella', barcode: '3017620422003' });
		await seedList({ listId: LIST, items: [remembered, live] });

		const result = await createItemFromScan(
			LIST,
			'3017620422003',
			product(),
			[remembered, live],
			[]
		);

		expect(result).toEqual({ itemId: live.id, created: false });
		expect((await db.items.get(remembered.id))?.deleted_at).not.toBeNull();
	});

	it('a REMEMBERED tombstone is reused and brought back, not duplicated', async () => {
		// It is listed under "Frühere Artikel" right now, so scanning it must land
		// on THAT row — and must lift the tombstone, or `onadded` reveals a row
		// that renders nowhere and the scanner looks broken ([D-18]).
		const bought = '2026-09-08T10:00:00.000Z';
		const remembered = makeItem({
			list: LIST,
			name: 'Nutella',
			barcode: '3017620422003',
			last_bought_at: bought,
			deleted_at: new Date().toISOString()
		});
		await seedList({ listId: LIST, items: [remembered] });

		const result = await createItemFromScan(LIST, '3017620422003', product(), [remembered], []);

		expect(result).toEqual({ itemId: remembered.id, created: false });
		const row = await db.items.get(remembered.id);
		expect(row?.deleted_at).toBeNull();
		expect(row?.checked).toBe(false);
		expect(row?.last_bought_at).toBe(bought);
	});

	it('a LIVING CHECKED name match is re-activated — the same door parity as typing the name', async () => {
		// The resolved-name half of scan dedup must re-activate a checked match,
		// not only lift tombstones: otherwise the scan "resolves" to a row that
		// renders nowhere and the scanner appears to do nothing, while typing the
		// same name re-activates it (applyDedupHit). Both the barcode pre-check
		// and this name match go through applyDedupHit.
		const checked = makeItem({
			list: LIST,
			name: 'Nutella',
			barcode: null, // not the scanned EAN: forces the name-dedup path
			checked: true,
			checked_at: '2026-09-08T10:00:00.000Z',
			last_bought_at: '2026-09-08T10:00:00.000Z'
		});
		await seedList({ listId: LIST, items: [checked] });
		const before = await db.items.count();

		const result = await createItemFromScan(LIST, '3017620422003', product(), [checked], []);

		expect(result).toEqual({ itemId: checked.id, created: false });
		expect(await db.items.count()).toBe(before); // no duplicate
		const row = await db.items.get(checked.id);
		expect(row?.checked).toBe(false); // re-activated, on the list again
		expect(row?.last_bought_at).toBe('2026-09-08T10:00:00.000Z'); // purchase kept
	});
});
