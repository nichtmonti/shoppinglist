import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, type Item, type PendingOp } from '../db';
import { applyEvent } from './sse';
import { putSynced, queueOp, resetDb } from '#lib/test-kit/db.js';
import { endSession, resetSessionForTest } from '../auth/session';

describe('sse.ts', () => {
	beforeEach(async () => {
		await resetDb(); // every table, the shadows included
		await db.items.clear();
		await db.list_categories.clear();
		await db.pending_ops.clear();
	});

	afterEach(async () => {
		await db.items.clear();
		await db.list_categories.clear();
		await db.pending_ops.clear();
		resetSessionForTest();
	});

	function pbItemRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'item-1',
			list: 'list-1',
			name: 'Milk',
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
			updated: '2024-01-01T00:00:00.000Z',
			created: '2024-01-01T00:00:00.000Z',
			deleted_at: null,
			...overrides
		};
	}

	describe('create event upserts the record', () => {
		it('applies normalized record to db', async () => {
			const pbRecord = pbItemRecord({ name: 'New Item' });

			await applyEvent('items', pbRecord, 'create');

			const result = await db.items.get('item-1');
			expect(result?.id).toBe('item-1');
			expect(result?.name).toBe('New Item');
		});
	});

	it('drops an event older than the shadow: it arrived after a newer answer', async () => {
		const newer = pbItemRecord({ quantity: '2', updated: '2024-01-02T00:00:00.000Z' });
		await applyEvent('items', newer, 'update');
		await applyEvent('items', pbItemRecord({ quantity: '1' }), 'update');

		expect((await db.server_items.get('item-1'))?.quantity).toBe('2');
		expect((await db.items.get('item-1'))?.quantity).toBe('2');
	});

	describe('update event upserts', () => {
		it('applies normalized record updates to existing db row', async () => {
			// Seed existing item
			await db.items.put({
				id: 'item-1',
				list: 'list-1',
				name: 'Old Name',
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
				updated: '2024-01-01T00:00:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			});

			const pbRecord = pbItemRecord({ name: 'Updated Name', updated: '2024-01-02T00:00:00.000Z' });

			await applyEvent('items', pbRecord, 'update');

			const result = await db.items.get('item-1');
			expect(result?.name).toBe('Updated Name');
			expect(result?.updated).toBe('2024-01-02T00:00:00.000Z');
		});
	});

	describe('delete event removes the row', () => {
		it('deletes item when no pending op', async () => {
			// Seed item
			await putSynced([pbItemRecord() as unknown as Item]);

			const pbRecord = pbItemRecord();

			await applyEvent('items', pbRecord, 'delete');

			const result = await db.items.get('item-1');
			expect(result).toBeUndefined();
		});
	});

	describe('a delete event removes the server row, queued edit or not', () => {
		it('drops the row and keeps the op for its push to settle (row_missing)', async () => {
			// Seed item + pending op
			await putSynced([pbItemRecord() as unknown as Item]);
			const pendingOp: PendingOp = {
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-1',
				list_id: 'list-1',
				type: 'update',
				changed: { quantity: '5' },
				base: { quantity: '1' },
				queued_at: new Date().toISOString()
			};
			await queueOp(pendingOp);

			const pbRecord = pbItemRecord();

			await applyEvent('items', pbRecord, 'delete');

			// docs/internals/design.md §8.5: the shadow goes and the row with it.
			expect(await db.server_items.get('item-1')).toBeUndefined();
			expect(await db.items.get('item-1')).toBeUndefined();
			expect(await db.pending_ops.count()).toBe(1);
		});
	});

	describe("field-level guard: update event does not overwrite a pending op's changed fields", () => {
		it('keeps local quantity 9 (pending) when server update has quantity 2', async () => {
			// Seed item with quantity 9
			const localItem = {
				id: 'item-1',
				list: 'list-1',
				name: 'Milk',
				quantity: '9',
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
				updated: '2024-01-01T00:00:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			await putSynced([localItem]);

			// Add pending op for quantity
			const pendingOp: PendingOp = {
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-1',
				list_id: 'list-1',
				type: 'update',
				changed: { quantity: '9' },
				base: { quantity: '1' },
				queued_at: new Date().toISOString()
			};
			await queueOp(pendingOp);

			// Server update comes with quantity 2
			const pbRecord = pbItemRecord({
				quantity: '2',
				name: 'Updated Name',
				updated: '2024-01-02T00:00:00.000Z'
			});

			await applyEvent('items', pbRecord, 'update');

			const result = await db.items.get('item-1');
			expect(result?.quantity).toBe('9'); // Guarded field stays local
			expect(result?.name).toBe('Updated Name'); // Non-changed field applies
			expect(result?.updated).toBe('2024-01-02T00:00:00.000Z');
		});
	});

	describe('update event with no pending op just upserts', () => {
		it('applies all fields when no pending op exists', async () => {
			// No pending op
			const pbRecord = pbItemRecord({
				name: 'New Item',
				quantity: '3',
				updated: '2024-01-02T00:00:00.000Z'
			});

			await applyEvent('items', pbRecord, 'update');

			const result = await db.items.get('item-1');
			expect(result?.name).toBe('New Item');
			expect(result?.quantity).toBe('3');
			expect(result?.updated).toBe('2024-01-02T00:00:00.000Z');
		});
	});

	// §5.6 [D-109]: the session is asked inside the write's transaction, so an
	// event already on its way when the account signs out writes nothing behind
	// the sign-out's wipe.
	describe('an event that lands after sign-out', () => {
		it('writes nothing', async () => {
			const landing = applyEvent('items', pbItemRecord({ name: 'Too late' }), 'create');
			endSession();
			await landing;

			expect(await db.items.get('item-1')).toBeUndefined();
		});

		it('removes nothing', async () => {
			await putSynced([pbItemRecord() as unknown as Item]);
			const landing = applyEvent('items', pbItemRecord(), 'delete');
			endSession();
			await landing;

			expect(await db.items.get('item-1')).toBeDefined();
		});
	});
});
