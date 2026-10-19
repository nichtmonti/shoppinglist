// Schema smoke test for the Dexie database.
import Dexie from 'dexie';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppDB, db, type Item, type PendingOp, getMeta, setMeta } from './db';
import { wipeLocalAccountData } from '#lib/auth/account-data.js';

// Helper for creating valid test items.
function sampleItem(overrides?: Partial<Item>): Item {
	const defaults: Item = {
		id: crypto.randomUUID(),
		list: 'list1',
		name: 'Milk',
		quantity: '2',
		note: null,
		category_key: null,
		checked: false,
		checked_at: null,
		last_bought_at: null,
		name_de: null,
		name_en: null,
		barcode: null,
		image_url: null,
		modified_by: null,
		updated: '2026-01-01T00:00:00.000Z',
		created: '2026-01-01T00:00:00.000Z',
		deleted_at: null
	};
	return { ...defaults, ...overrides };
}

describe('db schema', () => {
	beforeEach(async () => {
		// Ensure db is open and tables are clean for each test.
		await db.open();
		await db.items.clear();
		await db.list_categories.clear();
		await db.lists.clear();
		await db.memberships.clear();
		await db.roster.clear();
		await db.category_templates.clear();
		await db.item_dictionary.clear();
		await db.pending_ops.clear();
		await db.meta.clear();
		await db.scanned_products.clear();
	});

	afterEach(async () => {
		await db.items.clear();
		await db.list_categories.clear();
		await db.lists.clear();
		await db.memberships.clear();
		await db.roster.clear();
		await db.category_templates.clear();
		await db.item_dictionary.clear();
		await db.pending_ops.clear();
		await db.meta.clear();
		await db.scanned_products.clear();
	});

	it('opens the database', async () => {
		await db.open();
		expect(db.isOpen()).toBe(true);
	});

	it('round-trips an Item through items store', async () => {
		const item = sampleItem();
		await db.items.put(item);
		const retrieved = await db.items.get(item.id);
		expect(retrieved).toEqual(item);
	});

	it('queries pending_ops by record_id', async () => {
		const op: PendingOp = {
			op_id: 'op1',
			collection: 'items',
			record_id: 'item123',
			list_id: 'list1',
			type: 'update',
			changed: { name: 'Milk' },
			base: { name: 'Milk old' },
			queued_at: '2026-01-01T00:00:00.000Z'
		};
		await db.pending_ops.put(op);

		const results = await db.pending_ops.where('record_id').equals('item123').toArray();
		expect(results).toHaveLength(1);
		expect(results[0].op_id).toBe('op1');
	});

	it('round-trips meta values via getMeta/setMeta', async () => {
		await setMeta('last_synced_at', '2026-01-01');
		const value = await getMeta('last_synced_at');
		expect(value).toBe('2026-01-01');
	});

	it('round-trips a ListCategory through list_categories store', async () => {
		const category = {
			id: 'cat1',
			list: 'list1',
			slug: 'dairy',
			name: 'Dairy',
			icon: 'cow',
			color: '#FF0000',
			sort_order: 1,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2026-01-01T00:00:00.000Z',
			deleted_at: null
		};
		await db.list_categories.put(category);
		const retrieved = await db.list_categories.get('cat1');
		expect(retrieved).toEqual(category);
	});

	it('round-trips a ListRow through lists store', async () => {
		const list = {
			id: 'list1',
			name: 'Wocheneinkauf',
			updated: '2026-01-01T00:00:00.000Z'
		};
		await db.lists.put(list);
		const retrieved = await db.lists.get('list1');
		expect(retrieved).toEqual(list);
	});

	it('round-trips a Membership through memberships store', async () => {
		const membership = {
			id: 'mem1',
			account: 'acct1',
			list: 'list1',
			created: '2026-01-01T00:00:00.000Z',
			updated: '2026-01-01T00:00:00.000Z'
		};
		await db.memberships.put(membership);
		const retrieved = await db.memberships.get('mem1');
		expect(retrieved).toEqual(membership);
	});

	it('round-trips a RosterEntry through roster store', async () => {
		const entry = {
			id: 'list1_acct1',
			list: 'list1',
			account: 'acct1',
			nickname: 'Alice',
			joined: '2026-01-01T00:00:00.000Z'
		};
		await db.roster.put(entry);
		const retrieved = await db.roster.get('list1_acct1');
		expect(retrieved).toEqual(entry);
	});

	it('round-trips a CategoryTemplate through category_templates store', async () => {
		const template = {
			slug: 'dairy',
			name_i18n: { en: 'Dairy', de: 'Molkerei' },
			icon: 'cow',
			color: '#FF0000',
			sort_order: 1,
			retired: false
		};
		await db.category_templates.put(template);
		const retrieved = await db.category_templates.get('dairy');
		expect(retrieved).toEqual(template);
	});

	it('round-trips an ItemDictionary through item_dictionary store', async () => {
		const dict = {
			id: 'milk',
			names_i18n: { en: ['Milk', 'milk'], de: ['Milch'] },
			default_category: 'dairy',
			popularity: 10
		};
		await db.item_dictionary.put(dict);
		const retrieved = await db.item_dictionary.get('milk');
		expect(retrieved).toEqual(dict);
	});

	it('round-trips a ScannedProduct through scanned_products store', async () => {
		const product = {
			barcode: '1234567890123',
			name: 'Milk',
			image_url: 'https://example.com/milk.jpg',
			category_slug: 'dairy',
			looked_up_at: '2026-01-01T00:00:00.000Z'
		};
		await db.scanned_products.put(product);
		const retrieved = await db.scanned_products.get('1234567890123');
		expect(retrieved).toEqual(product);
	});

	it('queries items by list', async () => {
		const item1 = sampleItem({ id: 'item1', list: 'list1' });
		const item2 = sampleItem({ id: 'item2', list: 'list1' });
		const item3 = sampleItem({ id: 'item3', list: 'list2' });

		await db.items.bulkPut([item1, item2, item3]);

		const results = await db.items.where('list').equals('list1').toArray();
		expect(results).toHaveLength(2);
		expect(results.map((i) => i.id).sort()).toEqual(['item1', 'item2']);
	});

	it('queries items by checked status (boolean cannot be an index key — filter in memory)', async () => {
		const item1 = sampleItem({ id: 'item1', list: 'list_chk', checked: true });
		const item2 = sampleItem({ id: 'item2', list: 'list_chk', checked: false });
		const item3 = sampleItem({ id: 'item3', list: 'list_chk', checked: true });

		await db.items.bulkPut([item1, item2, item3]);

		const results = await db.items
			.where('list')
			.equals('list_chk')
			.filter((i) => i.checked)
			.toArray();
		expect(results).toHaveLength(2);
		expect(results.map((i) => i.id).sort()).toEqual(['item1', 'item3']);
	});

	it('queries pending_ops by collection', async () => {
		const op1: PendingOp = {
			op_id: 'op1',
			collection: 'items',
			record_id: 'item1',
			list_id: 'list1',
			type: 'update',
			changed: {},
			base: {},
			queued_at: '2026-01-01T00:00:00.000Z'
		};
		const op2: PendingOp = {
			op_id: 'op2',
			collection: 'list_categories',
			record_id: 'cat1',
			list_id: 'list1',
			type: 'update',
			changed: {},
			base: {},
			queued_at: '2026-01-01T00:00:00.000Z'
		};
		await db.pending_ops.bulkPut([op1, op2]);

		const results = await db.pending_ops.where('collection').equals('items').toArray();
		expect(results).toHaveLength(1);
		expect(results[0].op_id).toBe('op1');
	});
});

// The sign-out wipe ([D-21]'s argument, applied to Dexie). What it must drop is
// the account's data; what it must KEEP is the two things that are not the
// account's: the app's own shipped vocabulary, and the device's preferences.
describe('wipeLocalAccountData()', () => {
	beforeEach(async () => {
		await db.open();
		await Promise.all(db.tables.map((table) => table.clear()));
	});

	afterEach(async () => {
		await Promise.all(db.tables.map((table) => table.clear()));
	});

	it("drops every table holding the account's own data", async () => {
		const ts = '2026-01-01T00:00:00.000Z';
		await db.items.put(sampleItem());
		await db.lists.put({ id: 'list1', name: 'Familieneinkauf', updated: ts });
		await db.memberships.put({
			id: 'm1',
			account: 'a1',
			list: 'list1',
			created: ts,
			updated: ts
		});
		await db.roster.put({
			id: 'list1_a1',
			list: 'list1',
			account: 'a1',
			nickname: 'Anna',
			joined: ts
		});
		await db.list_categories.put({
			id: 'c1',
			list: 'list1',
			slug: 'obst',
			name: null,
			icon: '🍎',
			color: 'green',
			sort_order: 1,
			updated: ts,
			created: ts,
			deleted_at: null
		});
		await db.scanned_products.put({ barcode: '123', looked_up_at: ts });
		await db.pending_ops.put({
			op_id: 'op1',
			collection: 'items',
			record_id: 'item1',
			list_id: 'list1',
			type: 'update',
			changed: {},
			base: {},
			queued_at: '2026-01-01T00:00:00.000Z'
		});

		await wipeLocalAccountData();

		expect(await db.items.count()).toBe(0);
		expect(await db.lists.count()).toBe(0);
		expect(await db.memberships.count()).toBe(0);
		expect(await db.roster.count()).toBe(0);
		expect(await db.list_categories.count()).toBe(0);
		expect(await db.scanned_products.count()).toBe(0);
		// The outbox is the sharpest edge: pending_ops has no account column, so
		// anything left here drains under the NEXT account's token.
		expect(await db.pending_ops.count()).toBe(0);
	});

	it('keeps the app-seeded vocabulary, which is identical for every account', async () => {
		await db.category_templates.put({
			slug: 'obst',
			name_i18n: { de: 'Obst', en: 'Fruit' },
			icon: '🍎',
			color: 'green',
			sort_order: 1,
			retired: false
		});
		await db.item_dictionary.put({
			id: 'd1',
			names_i18n: { de: ['Milch'], en: ['Milk'] },
			default_category: 'obst',
			popularity: 1
		});
		await setMeta('seed_version', 'v3');

		await wipeLocalAccountData();

		// Clearing these would leave a device that signs back in OFFLINE with no
		// categories and no dictionary at all, for no privacy gain.
		expect(await db.category_templates.count()).toBe(1);
		expect(await db.item_dictionary.count()).toBe(1);
		expect(await getMeta('seed_version')).toBe('v3');
	});

	it("drops the cached invite tokens — the only plaintext copy of the lists' join credential", async () => {
		// [D-148]: keyed per list, so not in ACCOUNT_META_KEYS — and left behind
		// on the device after a sign-out until the wipe cleared them by prefix.
		await setMeta('invite_token_list1', { id: 'inv1', token: 'secret-join-token' });
		await setMeta('invite_token_list2', { id: 'inv2', token: 'another-token' });
		await setMeta('locale', 'de');

		await wipeLocalAccountData();

		expect(await getMeta('invite_token_list1')).toBeUndefined();
		expect(await getMeta('invite_token_list2')).toBeUndefined();
		expect(await getMeta('locale')).toBe('de');
	});

	it('keeps device preferences but drops the account-bound meta keys', async () => {
		await setMeta('locale', 'de');
		await setMeta('list_view', 'shop');
		await setMeta('list_row_sort', 'az');
		await setMeta('history_sort', 'category');
		await setMeta('list_sort', 'custom');
		await setMeta('install_prompt_dismissed', true);
		await setMeta('last_synced_at', '2026-01-01T00:00:00.000Z');
		await setMeta('memberships_synced_at', '2026-01-01T00:00:00.000Z');
		await setMeta('suppressed_names', ['milch']);
		await setMeta('list_order', ['list1', 'list2']);

		await wipeLocalAccountData();

		// §9.3/§12.2 make these per-DEVICE. Resetting the locale on sign-out in
		// particular would throw away a language choice the next user of this
		// device almost certainly still wants.
		expect(await getMeta('locale')).toBe('de');
		expect(await getMeta('list_view')).toBe('shop');
		expect(await getMeta('list_row_sort')).toBe('az');
		expect(await getMeta('history_sort')).toBe('category');
		expect(await getMeta('list_sort')).toBe('custom');
		expect(await getMeta('install_prompt_dismissed')).toBe(true);

		expect(await getMeta('last_synced_at')).toBeUndefined();
		// [D-182]: left behind, the next account's home would read "no lists"
		// before its own memberships were ever pulled.
		expect(await getMeta('memberships_synced_at')).toBeUndefined();
		// Account-bound by §6.11 — re-pulled from the account record on next sign-in.
		expect(await getMeta('suppressed_names')).toBeUndefined();
		// Device-local, but its VALUE is the previous account's list ids.
		expect(await getMeta('list_order')).toBeUndefined();
	});
});

// [D-08]: the list name moved from each member's membership row onto the list.
// A device upgrading from v4 holds its name only on the membership; until the
// first cycle brings the server's name, the list keeps the one this member gave it.
describe('the v5 migration', () => {
	const NAME = 'list-name-migration-test';
	afterEach(async () => {
		await Dexie.delete(NAME);
	});

	async function openV4(): Promise<Dexie> {
		const v4 = new Dexie(NAME);
		v4.version(4).stores({
			items: 'id, list',
			list_categories: 'id, list',
			lists: 'id',
			memberships: 'id, list',
			roster: 'id, list',
			category_templates: 'slug',
			item_dictionary: 'id',
			pending_ops: 'op_id, record_id, collection, list_id',
			meta: 'key',
			scanned_products: 'barcode',
			server_items: 'id, list',
			server_list_categories: 'id, list'
		});
		await v4.open();
		return v4;
	}

	const ts = '2026-01-01T00:00:00.000Z';
	const oldMembership = (id: string, list: string, display_name: string) => ({
		id,
		account: 'a1',
		list,
		display_name,
		created: ts,
		updated: ts
	});

	it('moves a membership’s display_name onto its list row, keeping the row’s updated', async () => {
		const v4 = await openV4();
		await v4.table('lists').put({ id: 'list1', updated: '2026-09-30T12:00:00.000Z' });
		await v4.table('memberships').put(oldMembership('m1', 'list1', 'Familieneinkauf'));
		v4.close();

		const v5 = new AppDB(NAME);
		await v5.open();
		expect(await v5.lists.get('list1')).toEqual({
			id: 'list1',
			name: 'Familieneinkauf',
			updated: '2026-09-30T12:00:00.000Z'
		});
		const membership = await v5.memberships.get('m1');
		expect(membership).toEqual({
			id: 'm1',
			account: 'a1',
			list: 'list1',
			created: ts,
			updated: ts
		});
		expect(membership).not.toHaveProperty('display_name');
		v5.close();
	});

	it('gives a membership whose list row is missing a named row of its own', async () => {
		const v4 = await openV4();
		await v4.table('memberships').put(oldMembership('m2', 'list2', 'Baumarkt'));
		v4.close();

		const v5 = new AppDB(NAME);
		await v5.open();
		// Never pulled, so no `updated`: the home shows no count for it yet ([D-185]).
		expect(await v5.lists.get('list2')).toEqual({ id: 'list2', name: 'Baumarkt' });
		expect(await v5.memberships.get('m2')).not.toHaveProperty('display_name');
		v5.close();
	});

	it('keeps a list row that already carries a name', async () => {
		const v4 = await openV4();
		await v4.table('lists').put({ id: 'list3', name: 'Vom Server', updated: ts });
		await v4.table('memberships').put(oldMembership('m3', 'list3', 'Mein Name'));
		v4.close();

		const v5 = new AppDB(NAME);
		await v5.open();
		expect((await v5.lists.get('list3'))?.name).toBe('Vom Server');
		v5.close();
	});
});

describe('the v6 migration', () => {
	const NAME = 'shelf-migration-test';
	afterEach(async () => {
		await Dexie.delete(NAME);
	});

	it('shelves every view row it finds, so the screens read them by index ([D-308])', async () => {
		const v5 = new Dexie(NAME);
		v5.version(5).stores({
			items: 'id, list',
			list_categories: 'id, list',
			lists: 'id',
			memberships: 'id, list',
			roster: 'id, list',
			category_templates: 'slug',
			item_dictionary: 'id',
			pending_ops: 'op_id, record_id, collection, list_id',
			meta: 'key',
			scanned_products: 'barcode',
			server_items: 'id, list',
			server_list_categories: 'id, list'
		});
		await v5.open();
		const checkedAt = '2026-09-30 12:00:00.000Z';
		await v5
			.table('items')
			.bulkPut([
				sampleItem({ id: 'open' }),
				sampleItem({ id: 'done', checked: true, checked_at: checkedAt }),
				sampleItem({ id: 'kept', deleted_at: checkedAt, last_bought_at: checkedAt }),
				sampleItem({ id: 'gone', deleted_at: checkedAt })
			]);
		v5.close();

		const v6 = new AppDB(NAME);
		await v6.open();
		const shelf = async (id: string) => {
			const row = await v6.items.get(id);
			return [row?.shelf, row?.shelf_at];
		};
		expect(await shelf('open')).toEqual(['open', 0]);
		expect(await shelf('done')).toEqual(['done', Date.parse('2026-09-30T12:00:00.000Z')]);
		expect(await shelf('kept')).toEqual(['kept', 0]);
		expect(await shelf('gone')).toEqual([undefined, undefined]);
		v6.close();
	});
});

describe('the v7 migration', () => {
	const NAME = 'density-migration-test';
	afterEach(async () => {
		await Dexie.delete(NAME);
	});

	it('moves a saved rows density to the list density that replaced it ([D-313])', async () => {
		const v6 = new Dexie(NAME);
		v6.version(6).stores({
			items: 'id, list, [list+shelf+shelf_at]',
			list_categories: 'id, list',
			lists: 'id',
			memberships: 'id, list',
			roster: 'id, list',
			category_templates: 'slug',
			item_dictionary: 'id',
			pending_ops: 'op_id, record_id, collection, list_id',
			meta: 'key',
			scanned_products: 'barcode',
			server_items: 'id, list',
			server_list_categories: 'id, list'
		});
		await v6.open();
		await v6.table('meta').bulkPut([
			{ key: 'ui_density', value: 'rows' },
			{ key: 'list_view', value: 'shop' }
		]);
		v6.close();

		const v7 = new AppDB(NAME);
		await v7.open();
		expect((await v7.meta.get('ui_density'))?.value).toBe('list');
		expect((await v7.meta.get('list_view'))?.value).toBe('shop');
		v7.close();
	});
});
