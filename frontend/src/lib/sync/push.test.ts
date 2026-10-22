// Push drain tests under fake-indexeddb (§8.2 step 6 + §8.3 + §8.4 + §8.6 spec validation).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, type Item, type ListCategory, type PendingOp } from '../db';
import { drainOutbox } from './push';
import { restoreRecord, updateRecord } from './outbox';
import { applyServerRows } from './apply';
import { shelve } from './materialize';
import { digestOf } from './digest';
import { MAX_OPS_PER_PUSH } from '#lib/field-contract.js';
import type { ConflictEntry } from './types';
import { endSession, resetSessionForTest } from '../auth/session';
import { putSynced, queueOp, resetDb } from '#lib/test-kit/db.js';

describe('push', () => {
	const listId = 'list-1';

	beforeEach(async () => {
		await resetDb(); // every table, the shadows included
		await Promise.all([
			db.items.clear(),
			db.list_categories.clear(),
			db.pending_ops.clear(),
			db.lists.clear(),
			db.memberships.clear(),
			db.roster.clear()
		]);
	});

	// Helper to seed a sample item row.
	async function seedItem(overrides: Partial<Item> = {}): Promise<Item> {
		const item: Item = {
			id: crypto.randomUUID(),
			list: listId,
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
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null,
			...overrides
		};
		await putSynced([item]);
		return item;
	}

	// The user edits a record while its push is in flight — through the real
	// outbox, which coalesces the edit into the op's pending layer.
	async function editInFlight(
		id: string,
		changed: Record<string, unknown>,
		rowOnly?: Record<string, unknown>
	): Promise<void> {
		await updateRecord('items', (await db.items.get(id))!, changed, { stamps: rowOnly });
	}

	// Helper to seed a sample pending op.
	async function seedOp(overrides: Partial<PendingOp> = {}): Promise<PendingOp> {
		const itemId = overrides.record_id ?? crypto.randomUUID();
		const op: PendingOp = {
			op_id: crypto.randomUUID(),
			collection: 'items',
			record_id: itemId,
			list_id: listId,
			type: 'create',
			changed: { name: 'Milk', quantity: '2' },
			base: {},
			queued_at: new Date().toISOString(),
			...overrides
		};
		await queueOp(op);
		return op;
	}

	it('empty outbox → {drained:0, failed:0}, no transport call', async () => {
		const transport = vi.fn().mockResolvedValue({ results: [] });
		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 0, failed: 0, requeued: 0 });
		expect(transport).not.toHaveBeenCalled();
	});

	it('applied settles the server record + drops the op', async () => {
		const item = await seedItem();
		const op = await seedOp({ record_id: item.id, type: 'update' });

		const serverRow = { ...item, quantity: '5', updated: '2026-01-02T00:00:00.000Z' };
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op.op_id, status: 'applied', record: serverRow }]
		});

		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });
		expect(transport).toHaveBeenCalledTimes(1);

		const row = await db.items.get(item.id);
		expect(row).toBeDefined();
		expect(row!.quantity).toBe('5');
		expect(row!.updated).toBe('2026-01-02T00:00:00.000Z');

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(0);
	});

	it('partial settles the winning record + emits a conflict notice', async () => {
		const item = await seedItem();
		const op = await seedOp({ record_id: item.id, type: 'update' });

		const serverRow = { ...item, quantity: '2', updated: '2026-01-02T00:00:00.000Z' };
		const conflicts: ConflictEntry[] = [
			{ field: 'quantity', mine: '5', theirs: '2', theirs_by: 'acctA' }
		];
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op.op_id, status: 'partial', record: serverRow, conflicts }]
		});

		const onConflict = vi.fn();
		const summary = await drainOutbox({ transport, onConflict });

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });

		const row = await db.items.get(item.id);
		expect(row).toBeDefined();
		expect(row!.quantity).toBe('2');

		expect(onConflict).toHaveBeenCalledTimes(1);
		expect(onConflict).toHaveBeenCalledWith({
			kind: 'partial',
			collection: 'items',
			record_id: item.id,
			conflicts
		});

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(0);
	});

	it('merged remaps + deletes the orphan', async () => {
		const deadId = crypto.randomUUID();
		const survivorId = crypto.randomUUID();

		// Seed optimistic dead row
		const deadRow = await seedItem({ id: deadId, name: 'Dead Row' });

		// Seed the merged op
		const mergedOp = await seedOp({ record_id: deadId, type: 'update' });

		// Seed a second pending op on deadId (to prove remap)
		const otherOp = await seedOp({
			record_id: deadId,
			type: 'update',
			changed: { name: 'Other Edit' }
		});

		// Server response: survivor row and conflicts
		const survivorRow = {
			...deadRow,
			id: survivorId,
			name: 'Merged Name',
			updated: '2026-01-02T00:00:00.000Z'
		};
		const conflicts: ConflictEntry[] = [
			{ field: 'quantity', mine: '5', theirs: '3', theirs_by: 'acctA' }
		];
		const transport = vi.fn().mockResolvedValue({
			results: [
				{
					op_id: mergedOp.op_id,
					status: 'merged',
					record_id: survivorId,
					record: survivorRow,
					conflicts
				}
			]
		});

		const onConflict = vi.fn();
		const summary = await drainOutbox({ transport, onConflict });

		// The merged op is processed (drained); the second op has no result so it is
		// left queued — but the merged handler already remapped it to the survivor.
		expect(summary.drained).toBe(1);

		// Survivor row exists: the server's merged row, with the remapped edit —
		// still queued, and about to be pushed to it — showing on top.
		const survivor = await db.items.get(survivorId);
		expect(survivor).toBeDefined();
		expect((await db.server_items.get(survivorId))!.name).toBe('Merged Name');
		expect(survivor!.name).toBe('Other Edit');

		// Dead row is GONE
		const dead = await db.items.get(deadId);
		expect(dead).toBeUndefined();

		// Second op remapped to survivor
		const remappedOp = await db.pending_ops.get(otherOp.op_id);
		expect(remappedOp).toBeDefined();
		expect(remappedOp!.record_id).toBe(survivorId);

		// Merged op dropped
		const mergedOpAfter = await db.pending_ops.get(mergedOp.op_id);
		expect(mergedOpAfter).toBeUndefined();

		// Conflict notice fired — carrying the SURVIVOR id: the dead row is already
		// deleted at this point, so a notice keyed to it could never resolve a
		// name, and the merged-with-conflicts toast would show an empty one.
		expect(onConflict).toHaveBeenCalledWith({
			kind: 'merged',
			collection: 'items',
			record_id: survivorId,
			conflicts
		});
	});

	it('merged with no conflicts does not fire onConflict', async () => {
		const deadId = crypto.randomUUID();
		const survivorId = crypto.randomUUID();

		const deadRow = await seedItem({ id: deadId });
		const mergedOp = await seedOp({ record_id: deadId });

		const survivorRow = { ...deadRow, id: survivorId, updated: '2026-01-02T00:00:00.000Z' };
		const transport = vi.fn().mockResolvedValue({
			results: [
				{
					op_id: mergedOp.op_id,
					status: 'merged',
					record_id: survivorId,
					record: survivorRow
					// no conflicts array
				}
			]
		});

		const onConflict = vi.fn();
		await drainOutbox({ transport, onConflict });

		expect(onConflict).not.toHaveBeenCalled();

		const survivor = await db.items.get(survivorId);
		expect(survivor).toBeDefined();
		const dead = await db.items.get(deadId);
		expect(dead).toBeUndefined();
	});

	it('denied drops the op, no settle', async () => {
		const item = await seedItem();
		const op = await seedOp({ record_id: item.id, type: 'update' });

		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op.op_id, status: 'denied' }] // no record
		});

		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });

		// Op dropped
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(0);

		// Row not settled: it shows the server's state again, which the shadow
		// holds — `updated` included, so the digest has nothing to repair.
		const row = await db.items.get(item.id);
		expect(row).toBeDefined();
		expect(row!.quantity).toBe('2'); // original value
		expect(row!.updated).toBe(item.updated);
	});

	// A denial is terminal, so the optimistic write must not survive it. Before this,
	// `denied` dropped the op and left the refused value on the row — and the §8.5
	// digest cannot repair that, because it hashes `{id}:{updated}` and the server's
	// `updated` never moved for a write it rejected.
	describe('denied reverts the optimistic write', () => {
		it('update: changed fields go back to base, others untouched', async () => {
			const item = await seedItem({ name: 'Milk', quantity: '99', note: 'keep me' });
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { quantity: '99' },
				base: { quantity: '2' }
			});

			const transport = vi.fn().mockResolvedValue({
				results: [
					{ op_id: op.op_id, status: 'denied', reason: 'field_too_long', field: 'quantity' }
				]
			});
			await drainOutbox({ transport });

			const row = await db.items.get(item.id);
			expect(row!.quantity).toBe('2'); // reverted to the last-synced server value
			expect(row!.note).toBe('keep me'); // untouched — not in `changed`
			expect(await db.pending_ops.toArray()).toHaveLength(0);
		});

		// [D-40] Found by an independent review: `base` is the server value as of
		// ENQUEUE. A co-member's newer value that arrived while the op was pending
		// was held off by the field guard — which still took the server's `updated`
		// — so the revert restored the older value under a digest that matched the
		// server, and nothing ever re-pulled the row.
		it('a co-member value that arrived while the edit waited shows at once after the denial', async () => {
			const item = await seedItem({ quantity: '99' }); // my optimistic edit
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { quantity: '99' },
				base: { quantity: '2' }
			});
			// Anna sets 5 meanwhile; my queued 99 still shows over it.
			const serverRow = { ...item, quantity: '5', updated: '2026-01-02T00:00:00.000Z' };
			await db.transaction('rw', [db.items, db.server_items, db.pending_ops], () =>
				applyServerRows('items', [serverRow])
			);
			expect((await db.items.get(item.id))!.quantity).toBe('99');

			const transport = vi.fn().mockResolvedValue({
				results: [
					{ op_id: op.op_id, status: 'denied', reason: 'field_too_long', field: 'quantity' }
				]
			});
			await drainOutbox({ transport });

			const row = (await db.items.get(item.id))!;
			// Not the enqueue-time base ('2', [D-40]'s best): the server's value now.
			expect(row.quantity).toBe('5');
			// And the digest already agrees — there is nothing left to re-pull.
			const local = await digestOf([{ id: row.id, updated: row.updated }]);
			const server = await digestOf([{ id: serverRow.id, updated: serverRow.updated }]);
			expect(local.hash).toBe(server.hash);
		});

		it('a settling result without a record marks the row for re-pull', async () => {
			const item = await seedItem({ quantity: '99' });
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { quantity: '99' },
				base: { quantity: '2' }
			});
			const transport = vi.fn().mockResolvedValue({
				results: [{ op_id: op.op_id, status: 'applied' }] // no record
			});
			await drainOutbox({ transport });

			expect(await db.pending_ops.toArray()).toHaveLength(0);
			expect((await db.items.get(item.id))!.updated).toBe('');
		});

		it('create: the row is deleted (base is {} — it exists nowhere else)', async () => {
			const item = await seedItem({ name: 'Caviar' });
			const op = await seedOp({ record_id: item.id, type: 'create' });

			const transport = vi.fn().mockResolvedValue({
				results: [{ op_id: op.op_id, status: 'denied', reason: 'not_member' }]
			});
			await drainOutbox({ transport });

			expect(await db.items.get(item.id)).toBeUndefined();
			expect(await db.pending_ops.toArray()).toHaveLength(0);
		});

		it('delete: a denied tombstone is lifted so the row reappears', async () => {
			const cat: ListCategory = {
				id: crypto.randomUUID(),
				list: listId,
				slug: 'other',
				name: 'Other',
				icon: '📦',
				color: 'gray',
				sort_order: 17,
				updated: '2026-01-01T00:00:00.000Z',
				created: '2025-12-01T00:00:00.000Z',
				deleted_at: '2026-02-01T00:00:00.000Z' // optimistic tombstone
			};
			await putSynced([], [cat]);
			const op = await seedOp({
				collection: 'list_categories',
				record_id: cat.id,
				type: 'update',
				changed: { deleted: true },
				base: { deleted: null }
			});

			const transport = vi.fn().mockResolvedValue({
				results: [{ op_id: op.op_id, status: 'denied', reason: 'protected_row', field: 'deleted' }]
			});
			await drainOutbox({ transport });

			const row = await db.list_categories.get(cat.id);
			expect(row!.deleted_at).toBeNull(); // [D-30]: "Other" survives, and so does the row
		});

		it('reports the reason + field to onDenied', async () => {
			const item = await seedItem();
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { note: 'x'.repeat(5000) },
				base: { note: null }
			});
			const onDenied = vi.fn();

			const transport = vi.fn().mockResolvedValue({
				results: [{ op_id: op.op_id, status: 'denied', reason: 'field_too_long', field: 'note' }]
			});
			await drainOutbox({ transport, onDenied });

			expect(onDenied).toHaveBeenCalledWith({
				collection: 'items',
				record_id: item.id,
				list_id: listId,
				reason: 'field_too_long',
				field: 'note'
			});
			expect((await db.items.get(item.id))!.note).toBeNull();
		});

		// The denied branch must not act on the STALE in-memory op: anything
		// coalesced into the op mid-flight (a field the server never saw) would be
		// stranded — and since a denial never moves `updated`, the §8.5 digest
		// could not repair it. Same discipline as settleRecord: re-read inside the
		// transaction, keep what moved on.
		it('keeps a field coalesced after send queued when the sent fields are denied', async () => {
			const item = await seedItem({ quantity: '2', note: null });
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { quantity: '99' },
				base: { quantity: '2', note: null }
			});

			const transport = vi.fn().mockImplementation(async () => {
				// quantity is in flight; the user edits the note → coalesced.
				await editInFlight(item.id, { note: 'frisch gekauft' });
				return {
					results: [
						{ op_id: op.op_id, status: 'denied', reason: 'field_too_long', field: 'quantity' }
					]
				};
			});
			const summary = await drainOutbox({ transport });

			// The refused quantity reverts; the never-sent note keeps both its
			// optimistic value and a queued op to push it.
			const row = await db.items.get(item.id);
			expect(row!.quantity).toBe('2');
			expect(row!.note).toBe('frisch gekauft');
			const remaining = await db.pending_ops.get(op.op_id);
			expect(remaining).toBeDefined();
			expect(remaining!.changed).toEqual({ note: 'frisch gekauft' });
			expect(remaining!.base).toEqual({ note: null });
			expect(summary).toEqual({ drained: 0, failed: 0, requeued: 1 }); // re-queued → re-sent
		});

		it('keeps a same-field re-edit: the newer value is re-queued, not clobbered to base', async () => {
			const item = await seedItem({ quantity: '2' });
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { quantity: '99' },
				base: { quantity: '2' }
			});

			const transport = vi.fn().mockImplementation(async () => {
				// '99' is in flight and refused; the user retypes to '50'.
				await editInFlight(item.id, { quantity: '50' });
				return {
					results: [
						{ op_id: op.op_id, status: 'denied', reason: 'field_too_long', field: 'quantity' }
					]
				};
			});
			await drainOutbox({ transport });

			expect((await db.items.get(item.id))!.quantity).toBe('50');
			const remaining = await db.pending_ops.get(op.op_id);
			expect(remaining!.changed).toEqual({ quantity: '50' });
			expect(remaining!.base).toEqual({ quantity: '2' });
		});

		it('a delete coalesced onto a denied op keeps the tombstone queued as a wire-only op', async () => {
			// The wire-only `deleted` shape on the re-queue path: the sent op
			// carried only quantity; the delete joined after send (its
			// rowOnly stamped the local tombstone), then the whole op was
			// refused. The delete was never attempted, so it must survive as a
			// queued op — with NO base entry, because `deleted` is a signal,
			// never a column (§8.2), and the server's per-field base coverage
			// skips it too (processUpdate skips field "deleted").
			const item = await seedItem({ quantity: '2' });
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { quantity: '99' },
				base: { quantity: '2' }
			});

			const transport = vi.fn().mockImplementation(async () => {
				// quantity is in flight; the user removes the row → coalesced, its
				// optimistic tombstone with it (what deleteRecord's rowOnly stamps).
				await editInFlight(item.id, { deleted: true }, { deleted_at: '2026-09-15T07:00:00.000Z' });
				return {
					results: [{ op_id: op.op_id, status: 'denied', reason: 'not_member' }]
				};
			});
			const summary = await drainOutbox({ transport });

			// The refused quantity reverts; the never-sent delete keeps both
			// its optimistic tombstone on the row and a queued op to push it.
			const row = await db.items.get(item.id);
			expect(row!.quantity).toBe('2');
			expect(row!.deleted_at).toBe('2026-09-15T07:00:00.000Z');
			const remaining = await db.pending_ops.get(op.op_id);
			expect(remaining).toBeDefined();
			expect(remaining!.changed).toEqual({ deleted: true });
			expect(remaining!.base).toEqual({}); // wire-only: no base entry, ever
			expect(summary).toEqual({ drained: 0, failed: 0, requeued: 1 }); // re-queued → re-sent
		});

		it('a denied create deletes row + op even when edits coalesced onto it in flight', async () => {
			const item = await seedItem({ name: 'Kaviar' });
			const op = await seedOp({ record_id: item.id, type: 'create' });

			const transport = vi.fn().mockImplementation(async () => {
				await editInFlight(item.id, { note: 'never seen by the server' });
				return {
					results: [{ op_id: op.op_id, status: 'denied', reason: 'not_member' }]
				};
			});
			await drainOutbox({ transport });

			// The coalesced edit rode a row the server refused to create — there
			// is nothing to preserve it for.
			expect(await db.items.get(item.id)).toBeUndefined();
			expect(await db.pending_ops.get(op.op_id)).toBeUndefined();
		});

		// [D-26]: the stamps cannot ride in base, so the op carries a `revert`
		// snapshot. Without it, a denial of an op that coalesced a check-off
		// with a refused field left checked_at = last_bought_at = now on a row
		// that was never bought — a fabricated purchase memory the §8.5 digest
		// cannot see, because the refusal never moved `updated`.
		it('a denied check-off and a denied restore show the server’s stamps again, from the shadow', async () => {
			// Through the real outbox: the shadow is the server row, the op carries the
			// optimistic stamps, and a denial simply drops the op.
			const bought = '2026-09-01T09:00:00.000Z';
			const milk = await seedItem({ name: 'Milch', last_bought_at: bought });
			const tea = await seedItem({ name: 'Tee', deleted_at: '2026-08-01T09:00:00.000Z' });
			const now = '2026-09-15T10:00:00.000Z';
			await updateRecord(
				'items',
				milk,
				{ checked: true },
				{
					stamps: {
						checked_at: now,
						last_bought_at: now
					}
				}
			);
			await restoreRecord('items', tea);
			expect((await db.items.get(milk.id))!.last_bought_at).toBe(now);
			expect((await db.items.get(tea.id))!.deleted_at).toBeNull();

			const ops = await db.pending_ops.toArray();
			const transport = vi.fn().mockResolvedValue({
				results: ops.map((o) => ({ op_id: o.op_id, status: 'denied', reason: 'not_member' }))
			});
			await drainOutbox({ transport });

			expect(await db.items.get(milk.id)).toEqual(shelve({ ...milk }));
			expect(await db.items.get(tea.id)).toEqual(shelve({ ...tea }));
			expect(await db.pending_ops.count()).toBe(0);
		});

		// The next three seed ops the way an older version queued them (with a
		// `revert` snapshot): the v3 migration's case, which the shadow takes over.
		it('restores the pre-op purchase stamps when a coalesced check-off is denied', async () => {
			const never = await seedItem({
				checked_at: '2026-09-15T10:00:00.000Z', // optimistic, as setChecked wrote
				last_bought_at: '2026-09-15T10:00:00.000Z'
			});
			const opNever = await seedOp({
				record_id: never.id,
				type: 'update',
				changed: { checked: true, note: 'x'.repeat(5000) },
				base: { checked: false, note: null },
				revert: { checked_at: null, last_bought_at: null }
			});

			const bought = '2026-09-01T09:00:00.000Z';
			const before = await seedItem({
				// Optimistic state as an UNcheck wrote it: checked cleared,
				// checked_at nulled; last_bought_at untouched (§6.6 persists).
				checked: false,
				checked_at: null,
				last_bought_at: bought
			});
			const opBought = await seedOp({
				record_id: before.id,
				type: 'update',
				changed: { checked: false, note: 'x'.repeat(5000) },
				base: { checked: true, note: null },
				revert: { checked_at: bought }
			});

			const transport = vi.fn().mockResolvedValue({
				results: [
					{ op_id: opNever.op_id, status: 'denied', reason: 'field_too_long', field: 'note' },
					{ op_id: opBought.op_id, status: 'denied', reason: 'field_too_long', field: 'note' }
				]
			});
			await drainOutbox({ transport });

			// Never-bought: back to NO purchase memory at all.
			const rowNever = await db.items.get(never.id);
			expect(rowNever!.checked).toBe(false);
			expect(rowNever!.checked_at).toBeNull();
			expect(rowNever!.last_bought_at).toBeNull();

			// Bought-before: back to the REAL date, not the optimistic overwrite.
			const rowBefore = await db.items.get(before.id);
			expect(rowBefore!.checked).toBe(true);
			expect(rowBefore!.checked_at).toBe(bought);
			expect(rowBefore!.last_bought_at).toBe(bought);
		});

		it('restore: a denied restore puts the tombstone back from the revert snapshot', async () => {
			// The optimistic lift is already applied (rowOnly nulled deleted_at);
			// the refusal never moved the server's `updated`, so the snapshot is
			// the ONLY thing that can hide the row again.
			const tombstone = '2026-08-01T09:00:00.000Z';
			const item = await seedItem({ deleted_at: null });
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { deleted: false },
				base: {},
				revert: { deleted_at: tombstone }
			});

			const transport = vi.fn().mockResolvedValue({
				results: [{ op_id: op.op_id, status: 'denied', reason: 'not_member' }]
			});
			await drainOutbox({ transport });

			expect((await db.items.get(item.id))!.deleted_at).toBe(tombstone);
			expect(await db.pending_ops.toArray()).toHaveLength(0);
		});

		it('a denial after a coalesced settle restores the SETTLED stamps, not the stale pre-op snapshot', async () => {
			// check-off sent → uncheck + over-long note coalesce mid-flight →
			// the check is APPLIED (the settle re-bases and re-queues the rest)
			// → the re-queued op is denied. The re-base refreshes `base` from the
			// settled record but leaves `revert` at the pre-CHECK capture, so the
			// denial stamps the row back to "never bought" while the server holds
			// today's purchase — the same digest-invisible corruption the
			// snapshot exists to prevent, one settle later.
			const item = await seedItem({ name: 'Milk' });
			const optimistic = '2026-09-15T10:00:00.000Z'; // what the check-off wrote locally
			await db.items.update(item.id, {
				checked: true,
				checked_at: optimistic,
				last_bought_at: optimistic
			});
			const op = await seedOp({
				record_id: item.id,
				type: 'update',
				changed: { checked: true },
				base: { checked: false },
				revert: { checked_at: null, last_bought_at: null } // never bought before the check
			});

			// Round 1: applied, with an uncheck (+ a doomed note edit) coalescing
			// onto the op in flight.
			const settled = '2026-09-15T10:00:01.000Z'; // the server's one-now() stamps
			const transport1 = vi.fn().mockImplementation(async () => {
				await editInFlight(
					item.id,
					{ checked: false, note: 'x'.repeat(5000) },
					{ checked_at: null }
				);
				return {
					results: [
						{
							op_id: op.op_id,
							status: 'applied',
							record: {
								...item,
								checked: true,
								checked_at: settled,
								last_bought_at: settled,
								updated: '2026-09-15T10:00:02.000Z'
							}
						}
					]
				};
			});
			await drainOutbox({ transport: transport1 });

			// The settle kept the coalesced op queued, re-based onto the server row.
			const requeued = await db.pending_ops.get(op.op_id);
			expect(requeued).toBeDefined();
			expect(requeued!.changed).toEqual({ checked: false, note: 'x'.repeat(5000) });
			expect(requeued!.base.checked).toBe(true); // re-based onto the APPLIED check

			// Round 2: the re-queued op is denied (the note is over the cap).
			const transport2 = vi.fn().mockResolvedValue({
				results: [{ op_id: op.op_id, status: 'denied', reason: 'field_too_long', field: 'note' }]
			});
			await drainOutbox({ transport: transport2 });

			const row = await db.items.get(item.id);
			expect(row!.checked).toBe(true); // reverted to the settled server value
			expect(row!.note).toBeNull();
			// The stamps must return to what the server HOLDS after the applied
			// check — restoring the stale pre-check snapshot instead erases a
			// purchase the server recorded, digest-invisible.
			expect(row!.checked_at).toBe(settled);
			expect(row!.last_bought_at).toBe(settled);
		});
	});

	it('gone wipes the list local data + ops', async () => {
		// Seed list row
		await db.lists.put({ id: listId, name: 'Wocheneinkauf', updated: '2026-01-01T00:00:00.000Z' });

		// Seed 2 items for the list
		await db.items.put({
			id: crypto.randomUUID(),
			list: listId,
			name: 'Item 1',
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
			deleted_at: null
		});
		await db.items.put({
			id: crypto.randomUUID(),
			list: listId,
			name: 'Item 2',
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
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null
		});

		// Seed 1 membership
		await db.memberships.put({
			id: crypto.randomUUID(),
			account: 'acct-1',
			list: listId,
			created: '2025-12-01T00:00:00.000Z',
			updated: '2026-01-01T00:00:00.000Z'
		});

		// Seed 1 roster entry
		await db.roster.put({
			id: `${listId}_acct-1`,
			list: listId,
			account: 'acct-1',
			nickname: 'Nick',
			joined: '2025-12-01T00:00:00.000Z'
		});

		// Seed 3 pending ops for this list
		await seedOp({ list_id: listId, record_id: crypto.randomUUID() });
		await seedOp({ list_id: listId, record_id: crypto.randomUUID() });
		await seedOp({ list_id: listId, record_id: crypto.randomUUID() });

		// One op returns 'gone'
		const firstOp = (await db.pending_ops.toArray())[0];
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: firstOp.op_id, status: 'gone' }]
		});

		const onGone = vi.fn();
		const summary = await drainOutbox({ transport, onGone });

		expect(summary.drained).toBeGreaterThan(0);

		// List is gone
		const list = await db.lists.get(listId);
		expect(list).toBeUndefined();

		// Items for this list are gone
		const items = await db.items.where('list').equals(listId).toArray();
		expect(items).toHaveLength(0);

		// Memberships for this list are gone
		const memberships = await db.memberships.where('list').equals(listId).toArray();
		expect(memberships).toHaveLength(0);

		// Roster for this list is gone
		const roster = await db.roster.where('list').equals(listId).toArray();
		expect(roster).toHaveLength(0);

		// All pending ops for this list are gone
		const ops = await db.pending_ops.where('list_id').equals(listId).toArray();
		expect(ops).toHaveLength(0);

		// onGone fired, carrying the name read BEFORE the purge deleted the
		// list row it lives on ([D-138], [D-08]).
		expect(onGone).toHaveBeenCalledWith(listId, 'Wocheneinkauf');
	});

	it('transport throw → keep all ops, {drained:0, failed:N}', async () => {
		const op1 = await seedOp({ record_id: crypto.randomUUID() });
		const op2 = await seedOp({ record_id: crypto.randomUUID() });
		const op3 = await seedOp({ record_id: crypto.randomUUID() });

		const transport = vi.fn().mockRejectedValue(new Error('network error'));

		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 0, failed: 3, requeued: 0, error: expect.any(Error) });

		// All ops still present
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(3);
		expect(ops.find((o) => o.op_id === op1.op_id)).toBeDefined();
		expect(ops.find((o) => o.op_id === op2.op_id)).toBeDefined();
		expect(ops.find((o) => o.op_id === op3.op_id)).toBeDefined();
	});

	it('noop settles the (unchanged) record + drops', async () => {
		const item = await seedItem();
		const op = await seedOp({ record_id: item.id, type: 'update' });

		const serverRow = { ...item, updated: '2026-01-02T00:00:00.000Z' }; // unchanged but with server stamp
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op.op_id, status: 'noop', record: serverRow }]
		});

		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });

		const row = await db.items.get(item.id);
		expect(row).toBeDefined();
		expect(row!.updated).toBe('2026-01-02T00:00:00.000Z');

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(0);
	});

	it('deleted_conflict settles + emits conflict notice', async () => {
		const item = await seedItem({ deleted_at: '2026-01-01T00:00:00.000Z' });
		const op = await seedOp({ record_id: item.id, type: 'update' });

		const tombstone = { ...item, updated: '2026-01-02T00:00:00.000Z' };
		const conflicts: ConflictEntry[] = [{ field: 'quantity', mine: '5', theirs: '2' }];
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op.op_id, status: 'deleted_conflict', record: tombstone, conflicts }]
		});

		const onConflict = vi.fn();
		const summary = await drainOutbox({ transport, onConflict });

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });

		const row = await db.items.get(item.id);
		expect(row).toBeDefined();
		expect(row!.deleted_at).toBe('2026-01-01T00:00:00.000Z');

		expect(onConflict).toHaveBeenCalledWith({
			kind: 'deleted_conflict',
			collection: 'items',
			record_id: item.id,
			conflicts
		});

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(0);
	});

	it('works with list_categories collection', async () => {
		const categoryId = crypto.randomUUID();
		const category: ListCategory = {
			id: categoryId,
			list: listId,
			slug: null,
			name: 'Produce',
			icon: '🍎',
			color: 'green',
			sort_order: 0,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null
		};
		await putSynced([], [category]);

		const op = await seedOp({
			collection: 'list_categories',
			record_id: categoryId,
			changed: { name: 'Updated Produce' }
		});

		const serverRow = { ...category, name: 'Server Produce', updated: '2026-01-02T00:00:00.000Z' };
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op.op_id, status: 'applied', record: serverRow }]
		});

		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });

		const row = await db.list_categories.get(categoryId);
		expect(row).toBeDefined();
		expect(row!.name).toBe('Server Produce');
	});

	it('missing result for an op leaves it queued', async () => {
		const op1RecId = crypto.randomUUID();
		const op1 = await seedOp({ record_id: op1RecId });
		const op1Row = await seedItem({ id: op1RecId });
		await seedOp({ record_id: crypto.randomUUID() });

		// Only return result for the first op
		const transport = vi.fn().mockResolvedValue({
			results: [{ op_id: op1.op_id, status: 'applied', record: op1Row }]
		});

		const summary = await drainOutbox({ transport });

		// Only one drained; the result-less op counts as failed (kept for the next drain —
		// the server omits a result when IT failed, so the op must not be dropped).
		expect(summary.drained).toBe(1);
		expect(summary.failed).toBe(1);

		// One op remains (the one without a result)
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
	});

	it('multiple ops processed in one batch', async () => {
		const item1 = await seedItem();
		const item2 = await seedItem();

		const op1 = await seedOp({ record_id: item1.id });
		const op2 = await seedOp({ record_id: item2.id });

		const transport = vi.fn().mockResolvedValue({
			results: [
				{
					op_id: op1.op_id,
					status: 'applied',
					record: { ...item1, updated: '2026-01-02T00:00:00.000Z' }
				},
				{
					op_id: op2.op_id,
					status: 'applied',
					record: { ...item2, updated: '2026-01-02T00:00:00.000Z' }
				}
			]
		});

		const summary = await drainOutbox({ transport });

		expect(summary).toEqual({ drained: 2, failed: 0, requeued: 0 });
		expect(transport).toHaveBeenCalledTimes(1); // single batch call

		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(0);
	});
	// --- in-flight coalescing (§8.2 step 3 merges into an op whose push is already out) ---

	it('a mid-flight check-off keeps checked and checked_at consistent', async () => {
		const recId = crypto.randomUUID();
		const row = await seedItem({ id: recId, checked: false, checked_at: null });
		const op = await seedOp({
			record_id: recId,
			type: 'update',
			changed: { quantity: '3' },
			base: { quantity: '2' }
		});

		const transport = vi.fn().mockImplementation(async () => {
			// The user checks the item off while the quantity push is in flight.
			const current = (await db.items.get(recId))!;
			await updateRecord(
				'items',
				current,
				{ checked: true },
				{
					stamps: {
						checked_at: '2026-05-05T00:00:00.000Z'
					}
				}
			);
			return {
				results: [
					{
						op_id: op.op_id,
						status: 'applied',
						record: { ...row, quantity: '3', checked: false, checked_at: null, updated: 'srv-1' }
					}
				]
			};
		});

		await drainOutbox({ transport });

		const after = await db.items.get(recId);
		expect(after!.checked).toBe(true);
		// checked_at must ride along with checked — a checked row with a null checked_at falls
		// out of both the active list and the §9.1 recently-checked section.
		expect(after!.checked_at).toBe('2026-05-05T00:00:00.000Z');
	});

	it('an op coalesced into mid-flight is re-based and kept queued, not dropped', async () => {
		const recId = crypto.randomUUID();
		await seedItem({ id: recId, quantity: '2' });
		const op = await seedOp({
			record_id: recId,
			type: 'update',
			changed: { quantity: '3' },
			base: { quantity: '2' }
		});

		// While the push is in flight the user edits quantity again → coalesced into the SAME op.
		const transport = vi.fn().mockImplementation(async () => {
			await editInFlight(recId, { quantity: '9' });
			return {
				results: [
					{
						op_id: op.op_id,
						status: 'applied',
						record: { ...(await db.items.get(recId))!, quantity: '3', updated: 'srv-1' }
					}
				]
			};
		});

		const summary = await drainOutbox({ transport });

		// The op survives, re-based on what the server now holds.
		const remaining = await db.pending_ops.get(op.op_id);
		expect(remaining).toBeDefined();
		expect(remaining!.changed).toEqual({ quantity: '9' });
		expect(remaining!.base).toEqual({ quantity: '3' });
		expect(summary).toEqual({ drained: 0, failed: 0, requeued: 1 });

		// The unsent local edit is preserved; server-owned fields take the server value.
		const row = await db.items.get(recId);
		expect(row!.quantity).toBe('9');
		expect(row!.updated).toBe('srv-1');
	});

	it('an op NOT touched in flight settles and drops as before', async () => {
		const recId = crypto.randomUUID();
		const row = await seedItem({ id: recId, quantity: '2' });
		const op = await seedOp({
			record_id: recId,
			type: 'update',
			changed: { quantity: '3' },
			base: { quantity: '2' }
		});
		const transport = vi.fn().mockResolvedValue({
			results: [
				{ op_id: op.op_id, status: 'applied', record: { ...row, quantity: '3', updated: 'srv-1' } }
			]
		});

		const summary = await drainOutbox({ transport });
		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });
		expect(await db.pending_ops.get(op.op_id)).toBeUndefined();
		expect((await db.items.get(recId))!.quantity).toBe('3');
	});

	// A DIFFERENT op enqueued for the row after the drain snapshot (the classic
	// case: the add's undo tapped while the re-activation push settles) must keep
	// its optimistic write through the settle. Were the settled record put RAW,
	// the row would flap back to the server state until the queued op's own
	// drain, which a slow drain cycle can sit out for a minute.
	it('a settle does not clobber a different op enqueued for the row mid-flight', async () => {
		const recId = crypto.randomUUID();
		await seedItem({ id: recId, name: 'Kaffee' });
		const op = await seedOp({
			record_id: recId,
			type: 'update',
			changed: { checked: false },
			base: { checked: true }
		});

		const transport = vi.fn().mockImplementation(async () => {
			// The undo lands as a SEPARATE op while the first push is in flight.
			await db.pending_ops.add({
				op_id: crypto.randomUUID(),
				collection: 'items',
				record_id: recId,
				list_id: listId,
				type: 'update',
				changed: { deleted: true },
				base: {},
				stamps: { deleted_at: '2026-09-15T12:00:00.000Z' },
				queued_at: new Date().toISOString()
			});
			// The server's view of the row: applied, still LIVING (it has not
			// seen the delete).
			const server = { ...(await db.items.get(recId))!, deleted_at: null, updated: 'srv-1' };
			return { results: [{ op_id: op.op_id, status: 'applied', record: server }] };
		});
		await drainOutbox({ transport });

		// The settle takes the server's row shape and the pending delete still
		// shows on it, optimistic tombstone and all.
		const row = await db.items.get(recId);
		expect(row!.deleted_at).toBe('2026-09-15T12:00:00.000Z');
		expect(row!.updated).toBe('srv-1');
		// The settled op is gone; the delete stays queued for its own drain.
		const ops = await db.pending_ops.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].changed).toEqual({ deleted: true });
	});

	it('merged + coalesced in flight re-points the surviving op at the survivor id', async () => {
		const deadId = crypto.randomUUID();
		const survivorId = crypto.randomUUID();
		await seedItem({ id: deadId, name: 'Milch', quantity: '1' });
		const op = await seedOp({
			record_id: deadId,
			type: 'create',
			changed: { name: 'Milch', quantity: '1' },
			base: {}
		});

		const transport = vi.fn().mockImplementation(async () => {
			// A note is added to the dead row while the create is in flight.
			await editInFlight(deadId, { note: 'bio' });
			return {
				results: [
					{
						op_id: op.op_id,
						status: 'merged',
						record_id: survivorId,
						record: {
							...(await db.items.get(deadId))!,
							id: survivorId,
							quantity: '2',
							note: null,
							updated: 'srv-1'
						},
						conflicts: []
					}
				]
			};
		});

		await drainOutbox({ transport });

		// The op is now an update against the survivor, re-based on the survivor's server values.
		const remaining = await db.pending_ops.get(op.op_id);
		expect(remaining).toBeDefined();
		expect(remaining!.record_id).toBe(survivorId);
		expect(remaining!.type).toBe('update');
		// ONLY the note. name and quantity went out with the create and the
		// merge adjudicated them (the survivor's quantity '2' won over the
		// create's '1'), so under [D-40]'s in-flight/pending layers they settle
		// here instead of being re-based and re-sent. Before the split they
		// were carried back with the survivor's values as their new base —
		// harmless for a create whose values the merge kept, and the exact
		// mechanism by which a REJECTED field overwrote its winner one drain
		// later (audit-repro.test.ts's W2 case).
		expect(remaining!.changed).toEqual({ note: 'bio' });
		expect(remaining!.base).toEqual({ note: null });

		// The dead row is gone; the survivor carries the unsent note.
		expect(await db.items.get(deadId)).toBeUndefined();
		expect((await db.items.get(survivorId))!.note).toBe('bio');
	});

	// An outbox over the server's cap, MAX_OPS_PER_PUSH (500), must be split, or every drain
	// re-sends the same rejected batch and the device never syncs again.
	it('an outbox over the server cap drains in batches, oldest first', async () => {
		const ops: PendingOp[] = [];
		for (let i = 0; i < 501; i++) {
			const item = await seedItem();
			ops.push(
				await seedOp({
					record_id: item.id,
					// Zero-padded so queued_at sorts in creation order.
					queued_at: `2026-01-01T00:00:${String(i).padStart(3, '0')}Z`
				})
			);
		}

		const batchSizes: number[] = [];
		const sentOrder: string[] = [];
		const transport = vi.fn().mockImplementation(async (sent: { op_id: string }[]) => {
			batchSizes.push(sent.length);
			for (const o of sent) sentOrder.push(o.op_id);
			return {
				results: sent.map((o) => ({
					op_id: o.op_id,
					status: 'applied',
					record: { id: crypto.randomUUID(), list: listId, updated: 'srv-1' }
				}))
			};
		});

		const summary = await drainOutbox({ transport });

		// The internal chunk split is an implementation detail — assert the
		// contract (every batch within the shared cap) and that the drain emptied
		// the outbox, not the exact [500, 1] split. The cap is single-sourced from
		// the field contract (field-contract.ts), so pinning the split would only
		// guard drift that can no longer happen.
		expect(
			batchSizes.every((n) => n <= MAX_OPS_PER_PUSH),
			`every batch must be within the ${MAX_OPS_PER_PUSH}-op contract cap, got ${batchSizes.join(', ')}`
		).toBe(true);
		expect(summary).toEqual({ drained: 501, failed: 0, requeued: 0 });
		expect(sentOrder).toEqual(ops.map((o) => o.op_id));
		expect(await db.pending_ops.count()).toBe(0);
	});

	// The loop can stop while a drain reads the outbox: what it read is not sent.
	it('an abandoned drain sends nothing and leaves its ops queued', async () => {
		const item = await seedItem();
		await seedOp({ record_id: item.id });
		const transport = vi.fn();

		const summary = await drainOutbox({ transport, signal: AbortSignal.abort() });

		expect(transport).not.toHaveBeenCalled();
		expect(summary).toEqual({ drained: 0, failed: 0, requeued: 0 });
		expect(await db.pending_ops.count()).toBe(1);
	});

	it('a batch that fails keeps itself and every later batch queued', async () => {
		for (let i = 0; i < 501; i++) {
			const item = await seedItem();
			await seedOp({ record_id: item.id });
		}

		const transport = vi.fn().mockRejectedValue(new Error('offline'));
		const summary = await drainOutbox({ transport });

		// Stopped after the first failure rather than pushing the rest at a dead link.
		expect(transport).toHaveBeenCalledTimes(1);
		expect(summary).toEqual({ drained: 0, failed: 501, requeued: 0, error: expect.any(Error) });
		expect(await db.pending_ops.count()).toBe(501);
	});
	it('a gone list is announced once, and its sibling results settle nothing', async () => {
		await db.memberships.put({
			id: 'mem-1',
			account: 'acc-1',
			list: listId,
			created: '',
			updated: ''
		});
		// The notice is named from the list row ([D-08]) — read before the purge deletes it.
		await db.lists.put({ id: listId, name: 'Wocheneinkauf', updated: '' });
		const a = await seedItem();
		const b = await seedItem({ name: 'Brot' });
		const opA = await seedOp({ record_id: a.id, type: 'update', changed: { quantity: '5' } });
		const opB = await seedOp({ record_id: b.id, type: 'update', changed: { quantity: '6' } });
		const onGone = vi.fn();

		const summary = await drainOutbox({
			onGone,
			transport: async () => ({
				results: [
					{ op_id: opA.op_id, status: 'gone' },
					{ op_id: opB.op_id, status: 'applied', record: { ...b, quantity: '6' } }
				]
			})
		});

		expect(onGone).toHaveBeenCalledOnce();
		expect(onGone).toHaveBeenCalledWith(listId, 'Wocheneinkauf');
		expect(await db.items.where('list').equals(listId).count()).toBe(0);
		expect(summary).toEqual({ drained: 2, failed: 0, requeued: 0 });
	});

	it('a sign-out between two settles leaves the rest of the batch unsettled', async () => {
		resetSessionForTest();
		const a = await seedItem();
		const b = await seedItem({ name: 'Brot' });
		// Explicitly ordered: the drain goes oldest-first, and two ops seeded in the
		// same millisecond would otherwise tie and settle in random order.
		const opA = await seedOp({
			record_id: a.id,
			type: 'update',
			changed: { quantity: '5' },
			queued_at: '2026-09-29T10:00:00.000Z'
		});
		const opB = await seedOp({
			record_id: b.id,
			type: 'update',
			changed: { quantity: '6' },
			queued_at: '2026-09-29T10:00:01.000Z'
		});

		const summary = await drainOutbox({
			// The first settle's notice handler signs out, as a user could while the
			// batch is being applied.
			onConflict: () => endSession(),
			transport: async () => ({
				results: [
					{
						op_id: opA.op_id,
						status: 'partial',
						conflicts: [{ field: 'quantity', mine: '5', theirs: '3' }],
						record: { ...a, quantity: '3', updated: 'srv-a' }
					},
					{
						op_id: opB.op_id,
						status: 'applied',
						record: { ...b, quantity: '6', updated: 'srv-b' }
					}
				]
			})
		});

		expect(summary).toEqual({ drained: 1, failed: 1, requeued: 0 });
		expect((await db.items.get(b.id))?.updated).not.toBe('srv-b');
		expect(await db.pending_ops.get(opB.op_id)).toBeDefined();
		resetSessionForTest();
	});
});
