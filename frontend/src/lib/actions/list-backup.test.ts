// [D-72] buildListBackup: the list's rows as a backup document.
// Runs under the `server` vitest project (node env + fake-indexeddb via
// test-kit/setup.ts), same as the other plain lib suites.
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '#lib/db.js';
import { resetDb, makeItem, makeCategory, putMyList } from '#lib/test-kit/db.js';
import { BACKUP_FORMAT, BACKUP_VERSION, parseListBackup } from '#lib/backup.js';
import { buildListBackup } from './list-backup';

const LIST = 'list-1';

// Two living categories (sort_order 2 and 1 → c1/c0), one tombstoned; three
// living items — one with a null category, one pointing at the tombstoned
// category, one normal; one membership carrying the display name.
async function seedFixture(): Promise<void> {
	const catA = makeCategory({
		list: LIST,
		slug: 'produce',
		name: 'Obst',
		icon: '🍎',
		color: 'green',
		sort_order: 2,
		created: '2025-01-02T00:00:00.000Z'
	});
	const catB = makeCategory({
		list: LIST,
		slug: 'dairy',
		name: 'Milch',
		icon: '🥛',
		color: 'sky',
		sort_order: 1,
		created: '2025-01-01T00:00:00.000Z'
	});
	const catTomb = makeCategory({
		list: LIST,
		slug: 'other',
		name: 'Weg',
		deleted_at: '2025-02-01T00:00:00.000Z'
	});
	await db.list_categories.bulkPut([catA, catB, catTomb]);

	const itemNull = makeItem({
		list: LIST,
		name: 'Brot',
		quantity: '1',
		category_key: null,
		created: '2025-01-03T00:00:00.000Z'
	});
	const itemTombCat = makeItem({
		list: LIST,
		name: 'Apfel',
		quantity: '2',
		category_key: catTomb.id,
		created: '2025-01-04T00:00:00.000Z'
	});
	const itemNormal = makeItem({
		list: LIST,
		name: 'Milch',
		name_en: 'Milk', // a scanned item's localized name rides along [D-21]
		quantity: '3',
		note: 'kalt',
		category_key: catB.id,
		barcode: '4000000000000',
		image_url: 'https://example.com/m.jpg',
		created: '2025-01-05T00:00:00.000Z'
	});
	// A checked+stamped row: the document carries its state ([D-72]).
	const itemChecked = makeItem({
		list: LIST,
		name: 'Zucker',
		quantity: '1',
		checked: true,
		checked_at: '2026-08-28T00:00:00.000Z',
		last_bought_at: '2026-08-28T00:00:00.000Z',
		created: '2025-01-06T00:00:00.000Z'
	});
	await db.items.bulkPut([itemNull, itemTombCat, itemNormal, itemChecked]);

	// [D-08] the name is the list's own, on its lists row — not on the membership.
	await putMyList(LIST, 'Wochenshop');
}

describe('buildListBackup', () => {
	beforeEach(async () => {
		await resetDb();
	});

	it('builds an exact, stateless per-list backup document', async () => {
		await seedFixture();

		const backup = await buildListBackup(LIST);

		expect(backup.format).toBe(BACKUP_FORMAT);
		expect(backup.version).toBe(BACKUP_VERSION);
		expect(backup.display_name).toBe('Wochenshop');
		expect(typeof backup.exported_at).toBe('string');

		// Categories sorted by sort_order: dairy (1) → c0, produce (2) → c1.
		expect(backup.categories).toEqual([
			{ key: 'c0', slug: 'dairy', name: 'Milch', icon: '🥛', color: 'sky', sort_order: 1 },
			{ key: 'c1', slug: 'produce', name: 'Obst', icon: '🍎', color: 'green', sort_order: 2 }
		]);

		// Items sorted by name (locale): Apfel, Brot, Milch, Zucker. The item
		// pointing at the tombstoned category degrades to null; the normal one
		// maps to c0; the checked one carries its state ([D-72]).
		expect(backup.items).toEqual([
			{
				name: 'Apfel',
				quantity: '2',
				note: null,
				category_key: null,
				barcode: null,
				image_url: null,
				checked: false
			},
			{
				name: 'Brot',
				quantity: '1',
				note: null,
				category_key: null,
				barcode: null,
				image_url: null,
				checked: false
			},
			{
				name: 'Milch',
				name_en: 'Milk',
				quantity: '3',
				note: 'kalt',
				category_key: 'c0',
				barcode: '4000000000000',
				image_url: 'https://example.com/m.jpg',
				checked: false
			},
			{
				name: 'Zucker',
				quantity: '1',
				note: null,
				category_key: null,
				barcode: null,
				image_url: null,
				checked: true,
				checked_at: '2026-08-28T00:00:00.000Z',
				last_bought_at: '2026-08-28T00:00:00.000Z'
			}
		]);

		// Key-set checks: no id/sync-timestamp/modified_by anywhere; the checked
		// state is carried only on the row that has it ([D-72]).
		expect(Object.keys(backup).sort()).toEqual([
			'categories',
			'display_name',
			'exported_at',
			'format',
			'items',
			'version'
		]);
		expect(Object.keys(backup.categories[0]).sort()).toEqual([
			'color',
			'icon',
			'key',
			'name',
			'slug',
			'sort_order'
		]);
		// An unchecked, unstamped row stays stateless — no checked_at/
		// last_bought_at keys at all.
		expect(Object.keys(backup.items[0]).sort()).toEqual([
			'barcode',
			'category_key',
			'checked',
			'image_url',
			'name',
			'note',
			'quantity'
		]);

		const json = JSON.stringify(backup);
		// A checked+stamped item ⇒ the document carries its stamps…
		expect(json).toContain('"checked_at"');
		expect(json).toContain('"last_bought_at"');
		// …while an unchecked, unstamped item carries neither key.
		expect(JSON.stringify(backup.items[0])).not.toContain('"checked_at"');
		expect(JSON.stringify(backup.items[0])).not.toContain('"last_bought_at"');
		expect(json).not.toContain('"updated"');
		expect(json).not.toContain('"created"');
		expect(json).not.toContain('"modified_by"');
		expect(json).not.toContain('"deleted_at"');
		expect(json).not.toContain('"id"');
	});

	it('round-trips through JSON', async () => {
		await seedFixture();

		const built = await buildListBackup(LIST);
		const result = parseListBackup(JSON.parse(JSON.stringify(built)));

		expect(result).toEqual({ ok: true, value: built });
	});
});
