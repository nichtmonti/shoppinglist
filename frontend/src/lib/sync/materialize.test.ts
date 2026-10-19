// The one rule for what a row shows (docs/internals/design.md §8.2 step 0): shadow ⊕ inflight ⊕ pending.
import { describe, expect, it } from 'vitest';
import type { Item, PendingOp } from '../db';
import { materialize, rowOf, type Layer, type LayeredOp } from './materialize';

const LIST = 'list-1';
const ID = 'item-1';

function server(overrides: Partial<Item> = {}): Item {
	return {
		id: ID,
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

const layer = (changed: Record<string, unknown>, stamps: Record<string, unknown> = {}): Layer => ({
	changed,
	base: {},
	stamps
});

function op(pending: Layer, inflight?: Layer, type: 'create' | 'update' = 'update'): LayeredOp {
	return { collection: 'items', record_id: ID, list_id: LIST, type, pending, inflight };
}

describe('materialize', () => {
	it('no server row and no edits: no row', () => {
		expect(materialize('items', undefined, undefined)).toBeUndefined();
	});

	it('a server row and no edits: exactly the server row, as a new object', () => {
		const shadow = server();
		const row = materialize('items', shadow, undefined);
		expect(row).toEqual(shadow);
		expect(row).not.toBe(shadow);
	});

	it('a create the server does not have yet: a blank row with the edits', () => {
		const row = materialize(
			'items',
			undefined,
			op(layer({ name: 'Brot', quantity: '2' }), undefined, 'create')
		) as Item;
		expect(row).toMatchObject({ id: ID, list: LIST, name: 'Brot', quantity: '2', updated: '' });
		expect(row.checked).toBe(false);
		expect(row.deleted_at).toBeNull();
	});

	it('an update to a row the server no longer has: no row', () => {
		expect(materialize('items', undefined, op(layer({ quantity: '2' })))).toBeUndefined();
	});

	it('edits override their fields; every other field is the server’s', () => {
		const row = materialize(
			'items',
			server({ note: 'bio', quantity: '1' }),
			op(layer({ quantity: '3' }))
		) as Item;
		expect(row.quantity).toBe('3');
		expect(row.note).toBe('bio');
		expect(row.updated).toBe('2026-09-29 10:00:00.000Z');
	});

	it('pending is applied after inflight', () => {
		const row = materialize(
			'items',
			server(),
			op(layer({ quantity: '3' }), layer({ quantity: '2', note: 'bio' }))
		) as Item;
		expect(row.quantity).toBe('3'); // the later edit
		expect(row.note).toBe('bio'); // still in flight, nothing newer
	});

	it('a newer server value shows through wherever nobody is editing', () => {
		const edits = op(layer({ quantity: '3' }));
		const before = materialize('items', server({ note: null }), edits) as Item;
		const after = materialize('items', server({ note: 'frisch' }), edits) as Item;
		expect(before.note).toBeNull();
		expect(after.note).toBe('frisch');
		expect(after.quantity).toBe('3');
	});

	it('the tombstone signal shows through its stamp, never as a column', () => {
		const removed = materialize(
			'items',
			server(),
			op(layer({ deleted: true }, { deleted_at: '2026-09-30T08:00:00.000Z' }))
		) as Item & { deleted?: unknown };
		expect(removed.deleted_at).toBe('2026-09-30T08:00:00.000Z');
		expect(removed.deleted).toBeUndefined();

		const restored = materialize(
			'items',
			server({ deleted_at: '2026-09-20 08:00:00.000Z' }),
			op(layer({ deleted: false }, { deleted_at: null }))
		) as Item;
		expect(restored.deleted_at).toBeNull();
	});

	it('a check-off shows its optimistic stamps until the server’s arrive', () => {
		const now = '2026-09-30T08:00:00.000Z';
		const row = materialize(
			'items',
			server({ last_bought_at: '2026-09-01 08:00:00.000Z' }),
			op(layer({ checked: true }, { checked_at: now, last_bought_at: now }))
		) as Item;
		expect(row).toMatchObject({ checked: true, checked_at: now, last_bought_at: now });
	});

	it('a denial is dropping a layer: without it the server row shows again', () => {
		const shadow = server({ note: null });
		const withEdit = op(layer({}), layer({ note: 'x'.repeat(5000) }));
		expect((materialize('items', shadow, withEdit) as Item).note).toHaveLength(5000);
		const denied: LayeredOp = { ...withEdit, inflight: undefined };
		expect(materialize('items', shadow, denied)).toEqual(shadow);
	});

	it('never mutates its inputs', () => {
		const shadow = server();
		const edits = op(layer({ quantity: '3' }, {}), layer({ note: 'bio' }));
		const frozen = JSON.stringify({ shadow, edits });
		materialize('items', shadow, edits);
		expect(JSON.stringify({ shadow, edits })).toBe(frozen);
	});

	it('categories get their own blank row', () => {
		const row = materialize('list_categories', undefined, {
			collection: 'list_categories',
			record_id: 'cat-1',
			list_id: LIST,
			type: 'create',
			pending: layer({ name: 'Getränke', icon: '🥤', color: 'sky', sort_order: 5 })
		});
		expect(row).toMatchObject({
			id: 'cat-1',
			list: LIST,
			slug: null,
			name: 'Getränke',
			sort_order: 5
		});
	});
});

describe('rowOf shelves an items row ([D-308])', () => {
	const checkOff: PendingOp = {
		op_id: 'op-1',
		collection: 'items',
		record_id: ID,
		list_id: LIST,
		type: 'update',
		changed: { checked: true },
		base: { checked: false },
		stamps: { checked_at: '2026-09-29T11:00:00.000Z', last_bought_at: '2026-09-29T11:00:00.000Z' },
		queued_at: '2026-09-29T11:00:00.000Z'
	};

	it('an active row is open, and a queued check-off moves it to done at its stamp', () => {
		expect(rowOf('items', server(), [])).toMatchObject({ shelf: 'open', shelf_at: 0 });
		expect(rowOf('items', server(), [checkOff])).toMatchObject({
			shelf: 'done',
			shelf_at: Date.parse('2026-09-29T11:00:00.000Z')
		});
	});

	it('a removed row is kept only when it was bought', () => {
		const removed = server({ deleted_at: '2026-09-29 12:00:00.000Z' });
		expect(rowOf('items', removed, [])).not.toHaveProperty('shelf');
		expect(
			rowOf('items', { ...removed, last_bought_at: '2026-09-01 10:00:00.000Z' }, [])
		).toMatchObject({ shelf: 'kept' });
	});
});
