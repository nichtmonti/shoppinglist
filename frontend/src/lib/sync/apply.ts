// The one place a view row is written (§8.2 step 0): every event changes the
// shadow or the op, then recomputes its rows through materialize.ts.
//
// Every function runs inside a transaction over `collectionTables`, so a local
// edit cannot land between the reads and the write ([D-40]).
import { collectionTables, db, shadowTable, syncTable, type PendingOp } from '../db';
import { groupByRecord, rowOf, type Row } from './materialize';
import { normalizeRecord } from './record';
import type { SyncCollection } from './types';

/**
 * Recompute the view rows of `ids` from their shadow and op: put what
 * materialize returns, delete the row where it returns nothing. One read of
 * the shadows and one of the (bounded) op set, however many ids.
 */
export async function recompute(collection: SyncCollection, ids: Iterable<string>): Promise<void> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return;
	const [shadows, ops] = await Promise.all([
		shadowTable(collection).bulkGet(unique),
		db.pending_ops.where('record_id').anyOf(unique).toArray()
	]);
	const opsById = groupByRecord(ops, collection);
	const puts: Row[] = [];
	const deletes: string[] = [];
	unique.forEach((id, i) => {
		const row = rowOf(collection, shadows[i], opsById.get(id) ?? []);
		if (row) puts.push(row);
		else deletes.push(id);
	});
	if (puts.length > 0) await syncTable(collection).bulkPut(puts);
	if (deletes.length > 0) await syncTable(collection).bulkDelete(deletes);
}

/** `recompute` for one record whose shadow and ops the caller already read. */
export async function recomputeKnown(
	collection: SyncCollection,
	id: string,
	shadow: Row | undefined,
	ops: PendingOp[]
): Promise<void> {
	const row = rowOf(collection, shadow, ops);
	if (row) await syncTable(collection).put(row);
	else await syncTable(collection).delete(id);
}

/**
 * Server rows arrived (snapshot, delta, SSE): they become the shadow, whole,
 * and their view rows are recomputed. Normalized once, here, for every caller.
 * Returns the ids written.
 */
export async function applyServerRows(
	collection: SyncCollection,
	rows: readonly object[]
): Promise<string[]> {
	const normalized = rows.map((r) => normalizeRecord(collection, r as Record<string, unknown>));
	const ids = normalized.map((r) => r.id);
	await shadowTable(collection).bulkPut(normalized);
	await recompute(collection, ids);
	return ids;
}

/**
 * A list-wide route (clear-history) changed `patch`'s fields on every row: the
 * shadows take it and the rows are recomputed, queued edits still on top. Opens
 * its own transaction (or joins the caller's).
 */
export async function applyServerPatch(
	collection: SyncCollection,
	listId: string,
	patch: Record<string, unknown>
): Promise<void> {
	await db.transaction('rw', collectionTables(collection), async () => {
		const shadows = shadowTable(collection).where('list').equals(listId);
		await shadows.modify(patch);
		await recompute(collection, await shadows.primaryKeys());
	});
}

/** The server no longer has these rows: their shadows go, and their view rows follow. */
export async function forgetServerRows(collection: SyncCollection, ids: string[]): Promise<void> {
	await shadowTable(collection).bulkDelete(ids);
	await recompute(collection, ids);
}
