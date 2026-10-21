// The liveQuery-backed views every component reads (§9.3). Components never
// touch Dexie directly: they subscribe here and mutate through #lib/actions/*.
import {
	db,
	getMeta,
	ownMembership,
	type Item,
	type ItemDictionary,
	type ListCategory,
	type ListRow,
	type Membership,
	type PendingOp
} from '#lib/db.js';
import {
	queryLatestCheckOffs,
	queryOpenRows,
	queryPendingOps,
	queryRememberedRows,
	queryShelfCounts,
	type ShelfCounts
} from '#lib/sync/index.js';
import { TRIP_GAP_MS } from '#lib/sorting.js';
import { live, preload, type LiveStore } from './live';
import {
	historySort,
	itemSort,
	localePref,
	listOrder,
	listSort,
	listView,
	uiDensity
} from './prefs';
import { suppressedNames } from './suppression';

/** A list the user is on: their membership row, with the list's name ([D-08]). */
export type MyList = Membership & { name: string };

/** A membership row joined with its list's row (absent until the cycle names it). */
function myList(membership: Membership, list: ListRow | undefined): MyList {
	return { ...membership, name: list?.name ?? '' };
}

/**
 * One membership per list, the newest. A list left and re-joined on another
 * device leaves this one a second row for it until the next sync drops the
 * stale one (cycle.ts), offline for as long as it is offline; every view
 * keys its lists by list, and a duplicate key blanked the home.
 */
function onePerList(rows: Membership[]): Membership[] {
	const byList = new Map<string, Membership>();
	for (const m of rows) {
		const kept = byList.get(m.list);
		if (!kept || m.updated > kept.updated) byList.set(m.list, m);
	}
	return [...byList.values()];
}

/** The user's lists ARE their membership rows (§9.3); the name is the list's own. */
export const memberships = live<MyList[]>(
	async () => {
		const [rows, lists] = await Promise.all([db.memberships.toArray(), db.lists.toArray()]);
		const byId = new Map(lists.map((l) => [l.id, l] as const));
		return onePerList(rows).map((m) => myList(m, byId.get(m.list)));
	},
	[],
	'memberships'
);

/**
 * The `lists` index. `updated` here is the digest's `max_updated`, the newest
 * item/category timestamp, which §9.3's "recent activity" order sorts on; it is
 * not the server's lists.updated column.
 */
export const listIndex = live(() => db.lists.toArray(), [], 'lists');

/** The mirrored global reference data (§6.12), read-only to clients. */
export const categoryTemplates = live(
	() => db.category_templates.toArray(),
	[],
	'category_templates'
);

/** The mirrored item dictionary (§6.9). One store per caller, so a remount
 * does not replay a previous value until the first emission lands. */
export function itemDictionary(): LiveStore<ItemDictionary[]> {
	return live(() => db.item_dictionary.toArray(), []);
}

/** `meta.last_synced_at`, stamped by the leader after each cycle (§12.1). */
export const lastSyncedAt = live<string | null>(
	async () => (await getMeta('last_synced_at')) ?? null,
	null,
	'meta:last_synced_at'
);

/**
 * `meta.memberships_synced_at`: set once this account's memberships have been
 * pulled ([D-182]). Null means an empty `memberships` table is not an answer yet.
 */
export const membershipsSyncedAt = live<string | null>(
	async () => (await getMeta('memberships_synced_at')) ?? null,
	null,
	'meta:memberships_synced_at'
);

// A list's rows as the screens read them ([D-308]): each screen subscribes to
// the rows it shows, never the whole list, whose history and tombstones only
// grow. Views still sort and bucket with #lib/sorting.

/** How many rows sit on each shelf: the home card's counts, without reading a row. */
export function listCounts(listId: string): LiveStore<ShelfCounts> {
	return live(() => queryShelfCounts(listId), { open: 0, done: 0, kept: 0 }, `counts:${listId}`);
}

/** The active list (§9.1): living, unchecked. */
export function listOpenItems(listId: string): LiveStore<Item[]> {
	return live(() => queryOpenRows(listId), [], `open:${listId}`);
}

/** The latest run of check-offs, which holds the current trip ([D-18]). */
export function listCheckOffs(listId: string): LiveStore<Item[]> {
	return live(() => queryLatestCheckOffs(listId, TRIP_GAP_MS), [], `checkoffs:${listId}`);
}

/** Living and remembered rows: what the add box, the import and the history read. */
export function listRememberedItems(listId: string): LiveStore<Item[]> {
	return live(() => queryRememberedRows(listId), [], `remembered:${listId}`);
}

/** Every category row of a list, tombstones included (the editor shows hidden ones). */
export function listCategories(listId: string): LiveStore<ListCategory[]> {
	return live(
		() => db.list_categories.where('list').equals(listId).toArray(),
		[],
		`list_categories:${listId}`
	);
}

/** The cached roster of a list (§7.4), its members in the order they joined,
 *  as the server lists them; the cache's own key order is by account id. */
export function listRoster(listId: string) {
	return live(
		() => db.roster.where('list').equals(listId).sortBy('joined'),
		[],
		`roster:${listId}`
	);
}

/** The membership row for one list, with the list's name. */
export function listMembership(listId: string): LiveStore<MyList | undefined> {
	return live<MyList | undefined>(
		async () => {
			const [m, list] = await Promise.all([ownMembership(listId), db.lists.get(listId)]);
			return m && myList(m, list);
		},
		undefined,
		`membership:${listId}`
	);
}

/**
 * `listId`'s queued ops, or the whole device's for `''` ([D-130]): what the
 * sync status ([D-296]), the §12.1 chip and the §9.3 unsynced counts read.
 */
export function outbox(listId: string): LiveStore<PendingOp[]> {
	return live(() => queryPendingOps(listId), [], `outbox:${listId}`);
}

/** How long a navigation waits for its screen's data before rendering anyway. */
const PRELOAD_CAP_MS = 1000;

/** `read`'s value, or `null` when it fails or takes longer than `capMs`. */
export function capped<T>(read: Promise<T>, capMs = PRELOAD_CAP_MS): Promise<T | null> {
	return Promise.race([
		read.catch(() => null),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), capMs))
	]);
}

/**
 * Everything the list screen reads on its first frame ([D-205]), awaited by its
 * route's `load`. Capped, so a stalled IndexedDB never holds a navigation; past
 * the cap the screens' `loaded` fallbacks apply.
 */
export async function preloadList(listId: string): Promise<void> {
	const reads = preload([
		memberships,
		membershipsSyncedAt,
		listIndex,
		lastSyncedAt,
		categoryTemplates,
		listMembership(listId),
		listRoster(listId),
		listCounts(listId),
		listOpenItems(listId),
		listCheckOffs(listId),
		listCategories(listId),
		outbox(listId),
		listView,
		uiDensity,
		itemSort,
		historySort,
		suppressedNames
	] as LiveStore<unknown>[]);
	await capped(reads);
}

/**
 * Everything the home screen reads on its first frame ([D-205]): the lists,
 * their order, and each card's counts, members and unsynced count.
 */
export async function preloadHome(): Promise<void> {
	const reads = (async () => {
		const rows = await db.memberships.toArray();
		await preload([
			memberships,
			membershipsSyncedAt,
			listIndex,
			lastSyncedAt,
			listSort,
			listOrder,
			outbox(''),
			...rows.flatMap((m) => [listCounts(m.list), listRoster(m.list), outbox(m.list)])
		] as LiveStore<unknown>[]);
	})();
	await capped(reads);
}

/** Everything the settings screen reads on its first frame ([D-205]). */
export async function preloadSettings(): Promise<void> {
	await capped(preload([memberships, suppressedNames, localePref] as LiveStore<unknown>[]));
}
