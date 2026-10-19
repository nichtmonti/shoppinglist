// The shadow store's invariant (docs/internals/design.md §8.2 step 0): every
// view row is exactly what its shadow and its queued ops make it (`rowOf`, the
// same function `recompute` writes with). Run by the integration world after
// every action and every sync, so the behaviour suite and the fuzz run hold the
// engine to it across thousands of steps. No exemptions: every writer
// recomputes in its own transaction, so a row that differs is a row some path
// wrote around the rule.
import { allCollectionTables, db, SHADOW_TABLES } from '#lib/db.js';
import { groupByRecord, rowOf, type Row } from '#lib/sync/materialize.js';
import { SYNC_COLLECTIONS } from '#lib/sync/types.js';

/** Rows that are not what the shadow and ops make them, as `collection:id what`. Empty when consistent. */
export async function shadowDivergence(): Promise<string[]> {
	return db.transaction('r', allCollectionTables(), async () => {
		const ops = await db.pending_ops.toArray();
		const out: string[] = [];
		for (const collection of SYNC_COLLECTIONS) {
			const opsById = groupByRecord(ops, collection);
			const [views, shadows] = await Promise.all([
				db.table(collection).toArray() as Promise<Row[]>,
				db.table(SHADOW_TABLES[collection]).toArray() as Promise<Row[]>
			]);
			const viewById = new Map(views.map((r) => [r.id, r] as const));
			const shadowById = new Map(shadows.map((r) => [r.id, r] as const));
			const ids = new Set([...viewById.keys(), ...shadowById.keys(), ...opsById.keys()]);
			for (const id of ids) {
				const at = `${collection}:${id}`;
				const view = viewById.get(id) as Record<string, unknown> | undefined;
				const expected = rowOf(collection, shadowById.get(id), opsById.get(id) ?? []) as
					Record<string, unknown> | undefined;
				if (!view || !expected) {
					if (view || expected) out.push(`${at} ${view ? 'row should not exist' : 'row missing'}`);
					continue;
				}
				for (const field of new Set([...Object.keys(view), ...Object.keys(expected)])) {
					const a = view[field] ?? null;
					const b = expected[field] ?? null;
					if (a !== b) {
						out.push(`${at} ${field}: row ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
					}
				}
			}
		}
		return out;
	});
}
