// The outbox (§8.2).
import { v4 } from 'uuid';
import { collectionTables, db, shadowTable, type PendingOp } from '../db';
import { SERVER_STAMPED_FIELDS } from '#lib/field-contract.js';
import { recomputeKnown } from './apply';
import { STAMP_COMPANIONS, isSignal } from './materialize';
import type { SyncCollection } from './types';

interface EnqueueArgs {
	collection: SyncCollection;
	listId: string;
	recordId: string;
	// The new field values being applied (e.g. {quantity:'3'} or {deleted:true}).
	changed: Record<string, unknown>;
	// 'create' only when this is the FIRST mutation of a freshly client-generated record.
	isCreate: boolean;
	// Optimistic values of server-stamped fields (deleted_at, checked_at): shown on
	// the row while queued, never sent; the settle replaces them ([D-40]).
	stamps?: Record<string, unknown>;
	// The row as the person saw it when they edited it: its values are the base.
	seen?: object;
}

/** The record an edit targets: any row of it carries both. */
export interface EditTarget {
	id: string;
	list: string;
}

// Server-stamped fields that must never appear in ops (§8.2 step 2) come from
// the shared contract — the same list the Go side refuses on (#lib/field-contract).

// Atomic write and coalesce (§8.2 steps 1–3); the row is recomputed from the op
// and the shadow (apply.ts), so the two cannot disagree.
async function enqueue(args: EnqueueArgs): Promise<void> {
	await db.transaction('rw', collectionTables(args.collection), async () => {
		// At most one op per record (coalescing). Filtered in JS: there is no
		// compound index on record_id and collection.
		const ops = (await db.pending_ops.where('record_id').equals(args.recordId).toArray()).filter(
			(op) => op.collection === args.collection
		);

		// A field's base is the server value the person saw when first editing it
		// (§8.2 step 2), so a co-member's value arriving meanwhile, even while the
		// edit was being made, still reads as a conflict ([D-11]). A field in
		// flight takes the in-flight layer's base: the re-edit builds on that
		// value, and stands or falls with it at the settle (push.ts keepPending).
		// Without a row, the shadow's.
		const shadow = await shadowTable(args.collection).get(args.recordId);
		const serverFields = shadow as unknown as Record<string, unknown> | undefined;
		const seen = (args.seen ?? {}) as Record<string, unknown>;
		const captureBase = (base: Record<string, unknown>, op?: PendingOp) => {
			if (!serverFields) return; // a create: base is {} (§8.2)
			for (const field of Object.keys(args.changed)) {
				if (isSignal(field) || (op && field in op.changed)) continue;
				const flying = op?.inflight && field in op.inflight.base ? op.inflight.base : undefined;
				const from = flying ?? (field in seen ? seen : serverFields);
				base[field] = from[field] ?? null;
			}
		};

		const existing = ops[0];
		if (existing) {
			// Coalesce into the pending layer; a field keeps its first base.
			const pendingBefore = Object.keys(existing.changed);
			captureBase(existing.base, existing);
			existing.changed = { ...existing.changed, ...args.changed };
			// A field's stamps go with the edit that set them: an uncheck leaves no
			// `last_bought_at` from the check it undoes, a purchase the server
			// never records.
			const stamps = { ...(existing.stamps ?? {}) };
			for (const field of Object.keys(args.changed)) {
				for (const stamp of STAMP_COMPANIONS[field] ?? []) delete stamps[stamp];
			}
			existing.stamps = { ...stamps, ...(args.stamps ?? {}) };
			dropReverted(
				existing,
				Object.keys(args.changed).filter((f) => pendingBefore.includes(f))
			);
			// "Not bought" belongs to an untick: a tick undone before it was sent
			// leaves nothing to take back, and a tick after it supersedes it.
			if ('bought' in existing.changed && existing.changed.checked !== false) {
				delete existing.changed.bought;
			}
			existing.queued_at = new Date().toISOString(); // refresh for drain ordering
			if (isEmptyUpdate(existing)) {
				// Undone before it was sent: nothing is left to push.
				await db.pending_ops.delete(existing.op_id);
				ops.length = 0;
			} else {
				await db.pending_ops.put(existing);
			}
		} else {
			const base: Record<string, unknown> = {};
			captureBase(base);
			const op: PendingOp = {
				op_id: v4(),
				collection: args.collection,
				record_id: args.recordId,
				list_id: args.listId,
				type: args.isCreate ? 'create' : 'update',
				changed: { ...args.changed },
				base,
				stamps: { ...(args.stamps ?? {}) },
				queued_at: new Date().toISOString()
			};
			await db.pending_ops.add(op);
			ops.push(op);
		}

		// The optimistic row: the shadow with the op on top.
		await recomputeKnown(args.collection, args.recordId, shadow, ops);
	});
}

/**
 * A pending edit set back to its base before it was sent is no edit, and is
 * not pushed: a check undone offline queues nothing. Only an edit undoing a
 * queued one: a first edit to the base value (reactivate's `checked: false`)
 * still says so against a co-member's change ([D-11]). Not for a field in
 * flight, whose pending value still has to follow the in-flight one.
 */
function dropReverted(op: PendingOp, fields: string[]): void {
	for (const field of fields) {
		if (!(field in op.base) || (op.inflight && field in op.inflight.changed)) continue;
		if (op.changed[field] !== op.base[field]) continue;
		delete op.changed[field];
		delete op.base[field];
	}
}

function isEmptyUpdate(op: PendingOp): boolean {
	return op.type === 'update' && !op.inflight && Object.keys(op.changed).length === 0;
}

// Strip server-stamped fields from changed (defensive, per §8.2 step 2).
function stripServerStampedFields(changed: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(changed)) {
		if (!SERVER_STAMPED_FIELDS.includes(k)) {
			result[k] = v;
		}
	}
	return result;
}

/**
 * Runs `edits`, outbox writes of `collection`, as one transaction: the views
 * re-read once for the batch instead of once per write.
 */
export function inOneCommit<T>(collection: SyncCollection, edits: () => Promise<T>): Promise<T> {
	return db.transaction('rw', collectionTables(collection), edits);
}

/**
 * Create a brand-new item/category. `fields` is the user-set fields (name required for items,
 * at minimum). recordId should be a v4() uuid generated by the caller (the caller owns
 * the id so it can render optimistically before calling). Returns the recordId.
 */
export async function createRecord(
	collection: SyncCollection,
	listId: string,
	recordId: string,
	fields: Record<string, unknown>,
	opts: { stamps?: Record<string, unknown> } = {}
): Promise<string> {
	// Strip the signals (a create is never born deleted, nor unbought) and the
	// server-stamped fields.
	const cleanFields = Object.fromEntries(
		Object.entries(stripServerStampedFields(fields)).filter(([field]) => !isSignal(field))
	);
	await enqueue({
		collection,
		listId,
		recordId,
		changed: cleanFields,
		isCreate: true,
		stamps: opts.stamps
	});
	return recordId;
}

/**
 * Edit an existing record. `stamps` are optimistic server-stamped values (§6.6):
 * an offline check-off needs `checked_at` to land in the checked section.
 */
export async function updateRecord(
	collection: SyncCollection,
	target: EditTarget,
	changed: Record<string, unknown>,
	opts: { stamps?: Record<string, unknown> } = {}
): Promise<void> {
	await enqueue({
		collection,
		listId: target.list,
		recordId: target.id,
		// Server-stamped fields must never be in ops.
		changed: stripServerStampedFields(changed),
		isCreate: false,
		stamps: opts.stamps,
		seen: target
	});
}

/** Tombstone-delete a record (sends deleted:true). */
export async function deleteRecord(collection: SyncCollection, target: EditTarget): Promise<void> {
	await enqueue({
		collection,
		listId: target.list,
		recordId: target.id,
		changed: { deleted: true },
		isCreate: false,
		// Optimistic tombstone, overwritten by the server's stamp ([D-45]).
		stamps: { deleted_at: new Date().toISOString() }
	});
}

/** Restore a tombstoned record (sends deleted:false). */
export async function restoreRecord(collection: SyncCollection, target: EditTarget): Promise<void> {
	await enqueue({
		collection,
		listId: target.list,
		recordId: target.id,
		changed: { deleted: false },
		isCreate: false,
		// Optimistic un-tombstone (mirrors deleteRecord): the row returns to the UI at once.
		stamps: { deleted_at: null }
	});
}

/**
 * All pending ops in queued_at order (the drain processes oldest-first).
 */
export async function pendingOpsOrdered(): Promise<PendingOp[]> {
	const ops = await db.pending_ops.toArray();
	return ops.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}
