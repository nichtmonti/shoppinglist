// The shadow store's seed (docs/internals/design.md §8.2 step 0): the server half of a row this
// device already holds, and the v3 migration that writes it for every row on
// the device.
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDB, type Item, type PendingOp } from '../db';
import { shadowFromLocal } from './shadow';
import { rowOf } from './materialize';

const LIST = 'list-1';

function row(overrides: Partial<Item> = {}): Item {
	return {
		id: 'item-1',
		list: LIST,
		name: 'Milch',
		name_de: null,
		name_en: null,
		quantity: '1',
		note: null,
		category_key: 'dairy',
		checked: false,
		checked_at: null,
		last_bought_at: null,
		barcode: null,
		image_url: null,
		modified_by: 'acc-ben',
		updated: '2026-09-29 10:00:00.000Z',
		created: '2026-09-01 10:00:00.000Z',
		deleted_at: null,
		...overrides
	};
}

function op(overrides: Partial<PendingOp>): PendingOp {
	return {
		op_id: 'op-1',
		collection: 'items',
		record_id: 'item-1',
		list_id: LIST,
		type: 'update',
		changed: {},
		base: {},
		queued_at: '2026-09-29T10:00:01.000Z',
		...overrides
	};
}

describe('shadowFromLocal', () => {
	it('takes a row with nothing queued as the server state, whole', () => {
		expect(shadowFromLocal(row(), undefined)).toEqual(row());
	});

	it('gives a queued create no shadow — the server does not have it', () => {
		expect(shadowFromLocal(row(), op({ type: 'create', changed: { name: 'Milch' } }))).toBe(
			undefined
		);
	});

	it('puts a queued edit back to its base and marks the row for repair', () => {
		const local = row({ quantity: '3', note: 'bio' });
		const queued = op({
			changed: { quantity: '3', note: 'bio' },
			base: { quantity: '1', note: null }
		});
		expect(shadowFromLocal(local, queued)).toEqual(row({ quantity: '1', note: null, updated: '' }));
	});

	it('restores a queued check-off’s stamps from its snapshot', () => {
		const local = row({
			checked: true,
			checked_at: '2026-09-29 10:00:01.000Z',
			last_bought_at: '2026-09-29 10:00:01.000Z'
		});
		const queued = op({
			changed: { checked: true },
			base: { checked: false },
			revert: { checked_at: null, last_bought_at: '2026-09-20 08:00:00.000Z' }
		});
		expect(shadowFromLocal(local, queued)).toEqual(
			row({ last_bought_at: '2026-09-20 08:00:00.000Z', updated: '' })
		);
	});

	it('lifts a queued delete’s optimistic tombstone: the server still has the row alive', () => {
		const local = row({ deleted_at: '2026-09-29 10:00:01.000Z' });
		const queued = op({ changed: { deleted: true } });
		expect(shadowFromLocal(local, queued)?.deleted_at).toBe(null);
	});

	it('gives a queued restore its tombstone back from the snapshot', () => {
		const queued = op({
			changed: { deleted: false },
			revert: { deleted_at: '2026-09-20 08:00:00.000Z' }
		});
		expect(shadowFromLocal(row(), queued)?.deleted_at).toBe('2026-09-20 08:00:00.000Z');
	});
});

describe('the v3 migration', () => {
	const NAME = 'shadow-migration-test';
	afterEach(async () => {
		await Dexie.delete(NAME);
	});

	it('seeds the shadow from the rows a v2 device holds', async () => {
		// A device on the previous schema, with one synced row, one edited and one created.
		const created = op({
			op_id: 'b',
			record_id: 'created',
			type: 'create',
			changed: { name: 'Milch' }
		});
		const v2 = new Dexie(NAME);
		v2.version(2).stores({
			items: 'id, list',
			list_categories: 'id, list',
			lists: 'id',
			memberships: 'id, list',
			roster: 'id, list',
			category_templates: 'slug',
			item_dictionary: 'id',
			pending_ops: 'op_id, record_id, collection, list_id',
			meta: 'key',
			scanned_products: 'barcode'
		});
		await v2.open();
		await v2
			.table('items')
			.bulkPut([
				row({ id: 'synced' }),
				row({ id: 'edited', quantity: '3' }),
				rowOf('items', undefined, [created]) as Item
			]);
		await v2.table('pending_ops').bulkPut([
			op({
				op_id: 'a',
				record_id: 'edited',
				changed: { quantity: '3' },
				base: { quantity: '1' }
			}),
			created
		]);
		v2.close();

		const v3 = new AppDB(NAME);
		await v3.open();
		const shadows = await v3.server_items.orderBy('id').toArray();
		expect(shadows).toEqual([
			row({ id: 'edited', quantity: '1', updated: '' }),
			row({ id: 'synced' })
		]);
		// The views still show the queued edit…
		expect((await v3.items.get('edited'))?.quantity).toBe('3');
		// …and every row is exactly what its shadow and op make it, as after any
		// other write ([D-40]'s invariant holds from the first open on).
		const ops = await v3.pending_ops.toArray();
		for (const view of await v3.items.toArray()) {
			const shadow = await v3.server_items.get(view.id);
			expect(view).toEqual(
				rowOf(
					'items',
					shadow,
					ops.filter((o) => o.record_id === view.id)
				)
			);
		}
		v3.close();
	});

	it('gives a queued check-off its optimistic stamps, so the upgraded row still shows them (v4)', async () => {
		const v2 = new Dexie(NAME);
		v2.version(2).stores({
			items: 'id, list',
			list_categories: 'id, list',
			lists: 'id',
			memberships: 'id, list',
			roster: 'id, list',
			category_templates: 'slug',
			item_dictionary: 'id',
			pending_ops: 'op_id, record_id, collection, list_id',
			meta: 'key',
			scanned_products: 'barcode'
		});
		await v2.open();
		const now = '2026-09-29 10:00:01.000Z';
		await v2.table('items').put(row({ checked: true, checked_at: now, last_bought_at: now }));
		await v2.table('pending_ops').put(
			op({
				changed: { checked: true },
				base: { checked: false },
				revert: { checked_at: null, last_bought_at: null }
			})
		);
		v2.close();

		const v4 = new AppDB(NAME);
		await v4.open();
		const upgraded = (await v4.pending_ops.get('op-1'))!;
		expect(upgraded.stamps).toMatchObject({ checked_at: now, last_bought_at: now });
		// The shadow is the server's half: never checked, never bought.
		expect(await v4.server_items.get('item-1')).toMatchObject({
			checked: false,
			checked_at: null,
			last_bought_at: null
		});
		v4.close();
	});
});
