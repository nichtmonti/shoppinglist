// Outbox tests under fake-indexeddb (§8.2 spec validation).
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import {
	createRecord,
	updateRecord,
	deleteRecord,
	restoreRecord,
	pendingOpsOrdered
} from './outbox';
import { asLayered } from './materialize';
import { type Item } from '../db';
import { putSynced, resetDb, updateSynced } from '#lib/test-kit/db.js';

describe('outbox', () => {
	const listId = 'list-1';

	beforeEach(async () => {
		await resetDb(); // every table, the shadows included
		await Promise.all([db.items.clear(), db.list_categories.clear(), db.pending_ops.clear()]);
	});

	// The record's queued op, read straight from the outbox table.
	async function pendingOpFor(collection: string, recordId: string) {
		const ops = await db.pending_ops.where('record_id').equals(recordId).toArray();
		return ops.find((o) => o.collection === collection);
	}

	// Helper to seed a synced item row (with server-stamped updated).
	async function seedSyncedItem(recordId: string, overrides: Partial<Item> = {}): Promise<Item> {
		const item: Item = {
			id: recordId,
			list: listId,
			name: 'Original Name',
			quantity: '1',
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
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null,
			...overrides
		};
		await putSynced([item]);
		return item;
	}

	it('createRecord writes row + op atomically', async () => {
		const recordId = crypto.randomUUID();
		await createRecord('items', listId, recordId, { name: 'Milk', quantity: '2' });

		// Row exists with all fields
		const row = await db.items.get(recordId);
		expect(row).toBeDefined();
		expect(row!.name).toBe('Milk');
		expect(row!.quantity).toBe('2');
		expect(row!.checked).toBe(false);
		expect(row!.updated).toBe(''); // no server stamp yet

		// Exactly ONE pending op, type 'create'
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].op_id).toBeDefined();
		expect(ops[0].collection).toBe('items');
		expect(ops[0].record_id).toBe(recordId);
		expect(ops[0].list_id).toBe(listId);
		expect(ops[0].type).toBe('create');
		expect(ops[0].changed).toEqual({ name: 'Milk', quantity: '2' });
		expect(ops[0].base).toEqual({}); // create → base is {}
		expect(ops[0].queued_at).toBeDefined();
	});

	it('a plain field edit carries no revert snapshot', async () => {
		const recordId = crypto.randomUUID();
		await seedSyncedItem(recordId);

		const row = (await db.items.get(recordId))!;
		await updateRecord('items', row, { quantity: '3' });

		const ops = await db.pending_ops.toArray();
		expect(ops[0].revert).toBeUndefined();
	});

	it('createRecord then updateRecord coalesces to ONE op, merged changed, base stays {}', async () => {
		const recordId = crypto.randomUUID();
		await createRecord('items', listId, recordId, { name: 'Milk', quantity: '2' });

		const row = await db.items.get(recordId);
		expect(row).toBeDefined();

		await updateRecord('items', row!, { quantity: '3' });

		// Still exactly ONE pending op
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].type).toBe('create'); // stays create
		expect(ops[0].changed).toEqual({ name: 'Milk', quantity: '3' }); // merged
		expect(ops[0].base).toEqual({}); // base still {}

		// Local row has updated quantity
		const updatedRow = await db.items.get(recordId);
		expect(updatedRow!.quantity).toBe('3');
	});

	it('two updateRecords on a synced record → one op, merged changed, base = FIRST capture', async () => {
		const recordId = crypto.randomUUID();
		const originalItem = await seedSyncedItem(recordId, {
			quantity: '1',
			note: 'original note'
		});

		// First update: quantity
		await updateRecord('items', originalItem, { quantity: '2' });

		// Second update: note (load the row after first update)
		const afterFirst = await db.items.get(recordId);
		expect(afterFirst).toBeDefined();
		await updateRecord('items', afterFirst!, { note: 'updated note' });

		// ONE op, type 'update', merged changed, base = FIRST capture
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].type).toBe('update');
		expect(ops[0].changed).toEqual({ quantity: '2', note: 'updated note' });
		// base has ORIGINAL values captured BEFORE first edit
		expect(ops[0].base.quantity).toBe('1'); // original
		expect(ops[0].base.note).toBe('original note'); // original
	});

	it('the base is the value the person saw, even if the server moved on while they edited', async () => {
		const recordId = crypto.randomUUID();
		const seen = await seedSyncedItem(recordId, { name: 'Äpfel' });
		await updateSynced(recordId, { name: 'Äpfel 153' }); // a co-member's rename lands meanwhile

		await updateRecord('items', seen, { name: 'äpfel' });

		// Against the server's 'Äpfel 153' it reads as a conflict, not as an edit of it.
		expect((await pendingOpFor('items', recordId))!.base).toEqual({ name: 'Äpfel' });
	});

	it('deleteRecord sends deleted:true and coalesces', async () => {
		const recordId = crypto.randomUUID();
		const originalItem = await seedSyncedItem(recordId, { name: 'Milk' });

		// First update
		await updateRecord('items', originalItem, { quantity: '2' });

		// Then delete
		const afterUpdate = await db.items.get(recordId);
		expect(afterUpdate).toBeDefined();
		await deleteRecord('items', afterUpdate!);

		// ONE op with both changed fields AND deleted:true
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].changed).toEqual({ quantity: '2', deleted: true });
	});

	it('restoreRecord sends deleted:false', async () => {
		const recordId = crypto.randomUUID();
		const originalItem = await seedSyncedItem(recordId);

		await restoreRecord('items', originalItem);

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].changed).toEqual({ deleted: false });
	});

	it('checked_at/last_bought_at/deleted_at never land in changed', async () => {
		const recordId = crypto.randomUUID();
		const originalItem = await seedSyncedItem(recordId);

		await updateRecord('items', originalItem, { checked: true, checked_at: 'x', deleted_at: 'y' });

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		// checked is in changed, but NOT checked_at or deleted_at
		expect(ops[0].changed.checked).toBe(true);
		expect(ops[0].changed.checked_at).toBeUndefined();
		expect(ops[0].changed.deleted_at).toBeUndefined();
	});

	it('pendingOpsOrdered returns oldest-first', async () => {
		// Create ops with different queued_at timestamps
		const id1 = crypto.randomUUID();
		const id2 = crypto.randomUUID();
		const id3 = crypto.randomUUID();

		// We need to manipulate queued_at to test ordering.
		// The easiest way is to create with tiny delays, but timestamps might be too close.
		// Instead, we'll manually insert ops with controlled queued_at.
		await db.pending_ops.bulkAdd([
			{
				op_id: crypto.randomUUID(),
				collection: 'items',
				record_id: id1,
				list_id: listId,
				type: 'create',
				changed: { name: 'First' },
				base: {},
				queued_at: '2026-01-01T10:00:00.000Z'
			},
			{
				op_id: crypto.randomUUID(),
				collection: 'items',
				record_id: id2,
				list_id: listId,
				type: 'create',
				changed: { name: 'Second' },
				base: {},
				queued_at: '2026-01-01T10:00:02.000Z'
			},
			{
				op_id: crypto.randomUUID(),
				collection: 'items',
				record_id: id3,
				list_id: listId,
				type: 'create',
				changed: { name: 'Third' },
				base: {},
				queued_at: '2026-01-01T10:00:01.000Z'
			}
		]);

		const ordered = await pendingOpsOrdered();
		expect(ordered).toHaveLength(3);
		// First element has smallest queued_at
		expect(ordered[0].queued_at).toBe('2026-01-01T10:00:00.000Z');
		expect(ordered[1].queued_at).toBe('2026-01-01T10:00:01.000Z');
		expect(ordered[2].queued_at).toBe('2026-01-01T10:00:02.000Z');
	});

	it('atomicity sanity: after createRecord, both row AND op exist', async () => {
		const recordId = crypto.randomUUID();
		await createRecord('items', listId, recordId, { name: 'Milk' });

		// Both must exist (we can't abort mid-transaction in fake-indexeddb tests easily)
		const row = await db.items.get(recordId);
		const op = await db.pending_ops.where('record_id').equals(recordId).toArray();

		expect(row).toBeDefined();
		expect(op).toHaveLength(1);
	});

	it('createRecord strips deleted from fields', async () => {
		const recordId = crypto.randomUUID();
		await createRecord('items', listId, recordId, {
			name: 'Milk',
			deleted: true // should be stripped
		});

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].changed.deleted).toBeUndefined();
		expect(ops[0].changed.name).toBe('Milk');
	});

	it('createRecord for list_categories', async () => {
		const recordId = crypto.randomUUID();
		await createRecord('list_categories', listId, recordId, {
			name: 'Produce',
			icon: '🍎',
			color: 'green'
		});

		const row = await db.list_categories.get(recordId);
		expect(row).toBeDefined();
		expect(row!.name).toBe('Produce');
		expect(row!.icon).toBe('🍎');
		expect(row!.color).toBe('green');

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].collection).toBe('list_categories');
		expect(ops[0].type).toBe('create');
	});

	it('updateRecord strips last_bought_at from changed', async () => {
		const recordId = crypto.randomUUID();
		const originalItem = await seedSyncedItem(recordId);

		await updateRecord('items', originalItem, {
			quantity: '2',
			last_bought_at: '2026-01-01T00:00:00.000Z'
		});

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].changed.quantity).toBe('2');
		expect(ops[0].changed.last_bought_at).toBeUndefined();
	});

	it('updateRecord on list_categories works', async () => {
		const recordId = crypto.randomUUID();
		// Seed a synced category
		await db.list_categories.put({
			id: recordId,
			list: listId,
			slug: null,
			name: 'Original',
			icon: '📦',
			color: 'gray',
			sort_order: 0,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null
		});

		const original = await db.list_categories.get(recordId);
		expect(original).toBeDefined();

		await updateRecord('list_categories', original!, { name: 'Updated' });

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].collection).toBe('list_categories');
		expect(ops[0].changed.name).toBe('Updated');
	});

	it('deleteRecord on list_categories works', async () => {
		const recordId = crypto.randomUUID();
		await db.list_categories.put({
			id: recordId,
			list: listId,
			slug: null,
			name: 'To Delete',
			icon: '📦',
			color: 'gray',
			sort_order: 0,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null
		});

		const original = await db.list_categories.get(recordId);
		expect(original).toBeDefined();

		await deleteRecord('list_categories', original!);

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].changed.deleted).toBe(true);
	});
	// --- optimistic tombstone: the row must leave the UI at once, offline included ---

	it('deleteRecord stamps a local deleted_at and keeps `deleted` off the row', async () => {
		const row = await seedSyncedItem(crypto.randomUUID());
		await deleteRecord('items', row);

		const stored = (await db.items.get(row.id)) as unknown as Record<string, unknown>;
		// The views filter on deleted_at — a null here would leave the item visible offline.
		expect(typeof stored.deleted_at).toBe('string');
		// `deleted` is a wire-only signal, never a column.
		expect('deleted' in stored).toBe(false);

		// The op still carries the boolean signal — the server owns the timestamp ([D-45]).
		const op = await pendingOpFor('items', row.id);
		expect(op!.changed).toEqual({ deleted: true });
		expect(op!.changed.deleted_at).toBeUndefined();
	});

	it('restoreRecord clears the local deleted_at', async () => {
		const row = await seedSyncedItem(crypto.randomUUID(), {
			deleted_at: '2026-01-01T00:00:00.000Z'
		});
		await restoreRecord('items', row);

		const stored = await db.items.get(row.id);
		expect(stored!.deleted_at).toBeNull();
		const op = await pendingOpFor('items', row.id);
		expect(op!.changed).toEqual({ deleted: false });
	});

	it('createRecord strips server-stamped fields from the op', async () => {
		const id = crypto.randomUUID();
		await createRecord('items', listId, id, {
			name: 'Milk',
			checked_at: 'nope',
			last_bought_at: 'nope',
			deleted_at: 'nope'
		});
		const op = await pendingOpFor('items', id);
		expect(op!.changed).toEqual({ name: 'Milk' });
	});

	// --- stamps: an op field's optimistic server-stamped companions ride on the op ---

	it('records the optimistic stamps on the op, and shows them while their field is queued', async () => {
		const row = await seedSyncedItem(crypto.randomUUID());
		const now = '2026-09-29T10:00:00.000Z';
		await updateRecord(
			'items',
			row,
			{ checked: true },
			{
				stamps: {
					checked_at: now,
					last_bought_at: now
				}
			}
		);
		const checkedOp = (await pendingOpFor('items', row.id))!;
		expect(checkedOp.stamps).toEqual({ checked_at: now, last_bought_at: now });
		expect(asLayered(checkedOp).pending.stamps).toEqual({ checked_at: now, last_bought_at: now });
		expect((await db.items.get(row.id))!.checked_at).toBe(now);

		const row2 = await seedSyncedItem(crypto.randomUUID());
		await deleteRecord('items', row2);
		const delOp = (await pendingOpFor('items', row2.id))!;
		// `deleted` is a signal, not a column: what shows is its `deleted_at` stamp.
		expect(Object.keys(delOp.stamps!)).toEqual(['deleted_at']);
		expect((await db.items.get(row2.id))!.deleted_at).toBe(delOp.stamps!.deleted_at);
	});

	// A check undone before it was sent: the check's `last_bought_at` stamp
	// would show a purchase the server never records, listing the item under
	// „Frühere Artikel“ once removed.
	describe('a check undone before it was sent', () => {
		const at = '2026-09-29T10:00:00.000Z';
		const check = (row: Item) =>
			updateRecord(
				'items',
				row,
				{ checked: true },
				{ stamps: { checked_at: at, last_bought_at: at } }
			);
		const uncheck = async (id: string) =>
			updateRecord(
				'items',
				(await db.items.get(id))!,
				{ checked: false },
				{
					stamps: { checked_at: null }
				}
			);

		it('queues nothing and leaves the row as the server has it', async () => {
			const bought = '2026-01-05T00:00:00.000Z';
			const row = await seedSyncedItem(crypto.randomUUID(), { last_bought_at: bought });
			await check(row);
			await uncheck(row.id);
			expect(await pendingOpFor('items', row.id)).toBeUndefined();
			const shown = (await db.items.get(row.id))!;
			expect(shown.checked).toBe(false);
			expect(shown.last_bought_at).toBe(bought);
		});

		it('keeps another queued edit, without the check’s stamps', async () => {
			const row = await seedSyncedItem(crypto.randomUUID());
			await check(row);
			await updateRecord('items', (await db.items.get(row.id))!, { note: 'bio' });
			await uncheck(row.id);
			const op = (await pendingOpFor('items', row.id))!;
			expect(op.changed).toEqual({ note: 'bio' });
			expect((await db.items.get(row.id))!.last_bought_at).toBeNull();
		});

		it('on an item created offline, shows no purchase', async () => {
			const id = crypto.randomUUID();
			await createRecord('items', listId, id, { name: 'Milch', checked: false });
			await check((await db.items.get(id))!);
			await uncheck(id);
			expect((await pendingOpFor('items', id))!.type).toBe('create');
			expect((await db.items.get(id))!.last_bought_at).toBeNull();
		});

		it('still sends the uncheck after a check already in flight', async () => {
			const row = await seedSyncedItem(crypto.randomUUID());
			await check(row);
			const sent = (await pendingOpFor('items', row.id))!;
			await db.pending_ops.put({
				...sent,
				inflight: { changed: sent.changed, base: sent.base, stamps: sent.stamps },
				changed: {},
				base: {},
				stamps: {}
			});
			await uncheck(row.id);
			const op = (await pendingOpFor('items', row.id))!;
			expect(op.changed).toEqual({ checked: false });
			// The check in flight is a purchase the server will record.
			expect((await db.items.get(row.id))!.last_bought_at).toBe(at);
		});
	});

	it('drops a stamp from the view once its field has left the op', () => {
		const layered = asLayered({
			op_id: 'op',
			collection: 'items',
			record_id: 'r',
			list_id: listId,
			type: 'update',
			changed: { quantity: '2' }, // `checked` settled; only the quantity is left
			base: { quantity: '1' },
			stamps: { checked_at: '2026-09-29T10:00:00.000Z' },
			queued_at: '2026-09-29T10:00:00.000Z'
		});
		expect(layered.pending.stamps).toEqual({});
	});
});
