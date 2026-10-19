// Read-only queries over the engine's own storage: the outbox, the health row,
// a list's rows by where they sit ([D-308]) and the synced rows a notice names. The app's views wrap them in a liveQuery
// (#lib/state/live), so they follow the tables; nothing here writes, and the
// tables and keys behind them stay the engine's business.
import { db, getMeta, syncTable, type Item, type ListCategory, type PendingOp } from '#lib/db.js';
import { NO_HEALTH, SYNC_HEALTH_KEY, type SyncHealth } from './health';
import type { SyncCollection } from './types';

/** `listId`'s queued ops, or the whole device's for `''` ([D-130]). */
export function queryPendingOps(listId: string): Promise<PendingOp[]> {
	return listId
		? db.pending_ops.where('list_id').equals(listId).toArray()
		: db.pending_ops.toArray();
}

/** What the leader last saw of the server ([D-296]), or no health yet. */
export async function querySyncHealth(): Promise<SyncHealth> {
	return (await getMeta(SYNC_HEALTH_KEY)) ?? NO_HEALTH;
}

/** A synced row by its collection and id, as the device holds it now. */
export function querySyncedRow(
	collection: SyncCollection,
	id: string
): Promise<Item | ListCategory | undefined> {
	return syncTable(collection).get(id);
}

type Shelf = NonNullable<Item['shelf']>;

/** `listId`'s rows on `shelf`, oldest check-off first on `done`. */
function onShelf(listId: string, shelf: Shelf) {
	return db.items
		.where('[list+shelf+shelf_at]')
		.between([listId, shelf], [listId, shelf, Infinity], true, true);
}

/** How many of a list's rows sit on each shelf: counted in the index, no row read. */
export interface ShelfCounts {
	open: number;
	done: number;
	kept: number;
}

export async function queryShelfCounts(listId: string): Promise<ShelfCounts> {
	const [open, done, kept] = await Promise.all(
		(['open', 'done', 'kept'] as const).map((shelf) => onShelf(listId, shelf).count())
	);
	return { open, done, kept };
}

/** The active list: living, unchecked. */
export function queryOpenRows(listId: string): Promise<Item[]> {
	return onShelf(listId, 'open').toArray();
}

/**
 * The list's latest run of check-offs, newest first: checked rows back from
 * the newest until a pause of `gapMs`. A superset of the current trip ([D-18]),
 * which #lib/sorting judges against the clock; never the whole history.
 */
export function queryLatestCheckOffs(listId: string, gapMs: number): Promise<Item[]> {
	let later: number | null = null;
	return onShelf(listId, 'done')
		.reverse()
		.until((row) => {
			const at = row.shelf_at ?? 0;
			const pause = later !== null && later - at >= gapMs;
			later = at;
			return pause;
		})
		.toArray();
}

/**
 * Every row a screen may show or match against: living, or removed and still
 * remembered for its purchase ([D-18]). The add box, the scanner, the import
 * and the history read these; a removed row never bought is left out.
 */
export function queryRememberedRows(listId: string): Promise<Item[]> {
	return db.items
		.where('[list+shelf+shelf_at]')
		.between([listId], [listId, '\uffff'], true, true)
		.toArray();
}
