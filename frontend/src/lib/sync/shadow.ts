// The shadow store's pure rules (docs/internals/design.md §8.2 step 0).
// Imported by db.ts for the v3 migration, so it reads nothing from storage.
import type { Item, ListCategory, PendingOp } from '../db';
import { isSignal } from './materialize';

/**
 * The server half of a row this device holds, for the v3 migration: the row
 * itself with no op, none for a create, and for an update the op's fields back
 * at their `base` with `updated` blanked, so the first cycle repairs it
 * ([D-40]). A wrong guess costs one pull.
 */
export function shadowFromLocal(
	row: Item | ListCategory,
	op: PendingOp | undefined
): Item | ListCategory | undefined {
	if (!op) return { ...row };
	if (op.type === 'create') return undefined;
	const shadow: Record<string, unknown> = { ...row };
	for (const field of Object.keys(op.changed)) {
		if (!isSignal(field)) {
			if (field in op.base) shadow[field] = op.base[field];
		} else if (field === 'deleted') {
			// The tombstone signal is not a column. A snapshot of the stamp says what
			// it was; without one, a queued delete means the row was alive, and a
			// queued restore leaves `deleted_at` as the repair will find it.
			if (op.revert && 'deleted_at' in op.revert) shadow.deleted_at = op.revert.deleted_at;
			else if (op.changed.deleted === true) shadow.deleted_at = null;
		}
	}
	for (const [field, value] of Object.entries(op.revert ?? {})) {
		if (field !== 'deleted_at') shadow[field] = value;
	}
	shadow.updated = '';
	return shadow as unknown as Item | ListCategory;
}
