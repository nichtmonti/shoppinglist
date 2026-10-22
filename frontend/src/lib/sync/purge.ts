// §8.6 vanished-list cleanup: purge a list's local data from every table that
// holds it (the two shadows included).
import { db, listDataTables } from '#lib/db.js';
import type { SyncNotices } from './types';

/** False when `owned` says the work it belongs to has ended (§5.6 [D-109]):
 *  asked inside the transaction, where a sign-out's wipe cannot interleave. */
export async function purgeList(
	listId: string,
	owned: () => boolean = () => true
): Promise<boolean> {
	return db.transaction('rw', listDataTables(), async () => {
		if (!owned()) return false;
		await db.pending_ops.where('list_id').equals(listId).delete();
		await db.items.where('list').equals(listId).delete();
		await db.list_categories.where('list').equals(listId).delete();
		await db.server_items.where('list').equals(listId).delete();
		await db.server_list_categories.where('list').equals(listId).delete();
		await db.roster.where('list').equals(listId).delete();
		await db.memberships.where('list').equals(listId).delete();
		await db.lists.delete(listId);
		return true;
	});
}

/**
 * Purge a list the server no longer gives this account, then raise the §8.6
 * notice with its name — read first, since the purge deletes the row it lives on.
 */
export async function purgeGoneList(
	listId: string,
	onGone: SyncNotices['onGone'],
	owned: () => boolean
): Promise<void> {
	const name = (await db.lists.get(listId))?.name ?? '';
	if (await purgeList(listId, owned)) onGone?.(listId, name);
}
