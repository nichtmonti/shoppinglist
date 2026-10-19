// The client's Dexie database: the local mirror the sync engine keeps and every
// view reads (§8, §12).
import Dexie, { type Table } from 'dexie';
import { SYNC_COLLECTIONS, type SyncCollection } from './sync/types';
import { shadowFromLocal } from './sync/shadow';
import { groupByRecord, rowOf, shelve, stampsFromRow } from './sync/materialize';
import type { SyncHealth } from './sync/health';
import type { HistorySort, ItemSort, ListSort, ListView, UiDensity } from './state/prefs';
import type { PendingSuppression } from './state/suppression';
import type { Locale } from './i18n';

// An items row; matches server itemRecordMap (backend/internal/sync/types.go).
export interface Item {
	id: string;
	list: string; // the list id (server relation serializes as id string)
	name: string;
	// A scanned product's names per UI language [D-21]; null on typed and
	// renamed items. Render through #lib/item-name. Older rows lack them: read
	// them as `?? null`.
	name_de: string | null;
	name_en: string | null;
	quantity: string;
	note: string | null;
	category_key: string | null;
	checked: boolean;
	checked_at: string | null; // server-stamped; never sent in ops
	last_bought_at: string | null; // server-stamped; never sent in ops
	barcode: string | null;
	image_url: string | null;
	modified_by: string | null; // account id or null
	updated: string; // server-stamped ISO ms string — drives the §8.5 digest hash
	created: string;
	deleted_at: string | null; // server-stamped tombstone
	// Local to the view row, never synced: where the row sits on its list and,
	// checked, when (sync/materialize.ts shelve). The screens read the rows they
	// show through the [list+shelf+shelf_at] index ([D-308]).
	shelf?: 'open' | 'done' | 'kept';
	shelf_at?: number;
}

// A list_categories row — matches server categoryRecordMap.
export interface ListCategory {
	id: string;
	list: string;
	slug: string | null;
	name: string | null;
	icon: string;
	color: string;
	sort_order: number;
	updated: string;
	created: string;
	deleted_at: string | null;
}

// A list the account belongs to, as the §8.5 digest reports it. `name` is the
// list's one name ([D-08]). `updated` is the digest's `max_updated` (what §9.3's
// "recent activity" order sorts on), NOT the server's `lists.updated`, which only
// a rename moves. It is absent until the cycle has pulled the list's rows, which
// makes it the home card's "pulled" signal ([D-185]).
export interface ListRow {
	id: string;
	name: string;
	updated?: string;
}

export interface Membership {
	id: string;
	account: string; // account id
	list: string; // list id
	created: string;
	updated: string;
}

// Per-list member cache (§7.4), keyed by rosterKey.
export interface RosterEntry {
	id: string; // rosterKey(list, account)
	list: string;
	account: string;
	nickname: string;
	joined: string; // ISO string from the roster route's `joined`
}

/** A roster entry's synthetic primary key. */
export function rosterKey(listId: string, accountId: string): string {
	return `${listId}_${accountId}`;
}

export interface CategoryTemplate {
	slug: string; // keyPath
	name_i18n: Record<string, string>;
	icon: string;
	color: string;
	sort_order: number;
	/** No longer copied into a list or offered to one ([D-300]); still names the rows lists have. */
	retired: boolean;
}

export interface ItemDictionary {
	id: string;
	names_i18n: Record<string, string[]>;
	default_category: string | null;
	popularity: number;
}

// A device-local barcode→product cache (§9.2). Never synced.
export interface ScannedProduct {
	barcode: string;
	found?: boolean;
	name?: string;
	name_de?: string;
	name_en?: string;
	image_url?: string;
	category_slug?: string;
	looked_up_at: string;
}

// One layer of a record's edits (§8.2 step 2).
export interface OpLayer {
	// Field values the user set; `deleted:true|false` is the wire-only tombstone signal.
	changed: Record<string, unknown>;
	// Per field: the shadow's value when the user first edited it (§8.2). Never
	// `deleted`, which is not a column.
	base: Record<string, unknown>;
	// Optimistic values of the server-stamped companions the edits set
	// (`checked_at`/`last_bought_at` on check-off, `deleted_at` on delete or
	// restore), latest write wins. Never sent; shown over the shadow while their
	// field is in `changed` (sync/materialize.ts asLayered).
	stamps?: Record<string, unknown>;
}

// The §8.2 outbox op in pending_ops: one per record, in two layers. The
// server-stamped columns never appear in changed/base.
//
// The op's own `changed`/`base`/`stamps` are its PENDING layer, not yet sent.
// `inflight` is the payload on the wire, frozen until a result settles it, so a
// retry after a lost answer re-sends exactly what the server may have committed
// (answered from its first delivery, [D-42]) and a re-edit goes out afterwards as its own
// push. The row shows shadow ⊕ inflight ⊕ pending (sync/materialize.ts).
export interface PendingOp extends OpLayer {
	op_id: string; // matches results to ops; with a layer's payload, names its delivery ([D-42])
	collection: SyncCollection;
	record_id: string;
	list_id: string;
	// Of the op's FIRST layer: a create stays a create until the server has it.
	type: 'create' | 'update';
	inflight?: OpLayer;
	// LEGACY (older stored ops): pre-op values of the stamps the op overrode.
	// Read only by the v3 migration to seed the shadow (sync/shadow.ts).
	revert?: Record<string, unknown>;
	// LEGACY (older stored ops), ignored: such an op is all pending.
	post_send?: string[];
	queued_at: string; // local ISO time: drain order
}

// A key-value store (§12): every key, with the value it holds. Device
// preferences are written by #lib/state/prefs.ts, the suppression mirror by
// #lib/state/suppression.ts; #lib/auth/account-data.ts says which keys a
// sign-out deletes.
export interface MetaValues {
	last_synced_at: string; // ISO, the last completed cycle (§8.5)
	memberships_synced_at: string; // ISO ([D-182])
	sync_health: SyncHealth; // [D-296]
	seed_version: string; // the mirrored reference data's (§6.12)
	suppressed_names: string[]; // §6.11
	suppressed_pending: PendingSuppression; // [D-137]
	list_view: ListView;
	ui_density: UiDensity;
	list_row_sort: ItemSort | null;
	history_sort: HistorySort;
	list_sort: ListSort;
	list_order: string[];
	locale: Locale;
	install_prompt_dismissed: boolean;
	// One per list: #lib/actions/invites's token cache ([D-148]).
	[key: `invite_token_${string}`]: { id: string; token: string };
}
export type MetaKey = keyof MetaValues;

export interface MetaRow {
	key: string;
	value: unknown;
}

export class AppDB extends Dexie {
	items!: Table<Item, string>;
	list_categories!: Table<ListCategory, string>;
	// The shadow store (§8.2 step 0): the last server state of each row, written
	// by every inbound path and push result, never by a local edit. Views read
	// `items`/`list_categories`.
	server_items!: Table<Item, string>;
	server_list_categories!: Table<ListCategory, string>;
	lists!: Table<ListRow, string>;
	memberships!: Table<Membership, string>;
	roster!: Table<RosterEntry, string>;
	category_templates!: Table<CategoryTemplate, string>;
	item_dictionary!: Table<ItemDictionary, string>;
	pending_ops!: Table<PendingOp, string>;
	meta!: Table<MetaRow, string>;
	scanned_products!: Table<ScannedProduct, string>;

	constructor(name = 'einkaufsliste_sync') {
		// Bind to the IndexedDB on the global NOW, not Dexie's module-load
		// snapshot: the two-client integration harness (src/integration/harness.ts)
		// installs a fake-indexeddb per client before importing this module, and
		// without this both clients would share one backing store.
		super(name, {
			indexedDB: globalThis.indexedDB ?? Dexie.dependencies.indexedDB,
			IDBKeyRange: globalThis.IDBKeyRange ?? Dexie.dependencies.IDBKeyRange
		});
		this.version(1).stores({
			// Booleans (e.g. `checked`) cannot be IndexedDB index keys: filter in JS.
			items: 'id, list, updated, category_key, deleted_at',
			list_categories: 'id, list, slug, deleted_at',
			lists: 'id, updated',
			memberships: 'id, account, list',
			roster: 'id, list',
			category_templates: 'slug, id',
			item_dictionary: 'id',
			pending_ops: 'op_id, record_id, collection, list_id',
			meta: 'key',
			scanned_products: 'barcode'
		});
		// v2: only the secondary indexes some `where()` uses; any other is write
		// amplification on the hottest tables. Index-only, no data migration.
		this.version(2).stores({
			items: 'id, list',
			list_categories: 'id, list',
			lists: 'id',
			memberships: 'id, list',
			category_templates: 'slug'
		});
		// v3: the shadow tables, seeded from the rows this device already holds
		// (shadowFromLocal says how a row with a queued edit gets its server half).
		this.version(3)
			.stores({ server_items: 'id, list', server_list_categories: 'id, list' })
			.upgrade(async (tx) => {
				const ops = (await tx.table('pending_ops').toArray()) as PendingOp[];
				const opByKey = new Map(ops.map((o) => [o.collection + ':' + o.record_id, o] as const));
				for (const collection of SYNC_COLLECTIONS) {
					const rows = (await tx.table(collection).toArray()) as (Item | ListCategory)[];
					const shadows = rows.flatMap((row) => {
						const shadow = shadowFromLocal(row, opByKey.get(collection + ':' + row.id));
						return shadow ? [shadow] : [];
					});
					await tx.table(SHADOW_TABLES[collection]).bulkPut(shadows);
				}
			});
		// v4: ops carry their optimistic stamps. An older op kept them on the row
		// alone, and the row is now computed from the op, so they are copied off
		// the row into the op.
		this.version(4).upgrade(async (tx) => {
			const ops = (await tx.table('pending_ops').toArray()) as PendingOp[];
			for (const op of ops) {
				if (op.stamps) continue;
				const row = (await tx.table(op.collection).get(op.record_id)) as
					Record<string, unknown> | undefined;
				await tx.table('pending_ops').put({ ...op, stamps: row ? stampsFromRow(row) : {} });
			}
			// Every row with a queued op becomes shadow ⊕ ops, as after any write
			// ([D-40]); v3 blanked such a shadow's `updated` for repair.
			const all = (await tx.table('pending_ops').toArray()) as PendingOp[];
			for (const collection of SYNC_COLLECTIONS) {
				for (const [id, mine] of groupByRecord(all, collection)) {
					const shadow = (await tx.table(SHADOW_TABLES[collection]).get(id)) as
						Item | ListCategory | undefined;
					const row = rowOf(collection, shadow, mine);
					if (row) await tx.table(collection).put(row);
					else await tx.table(collection).delete(id);
				}
			}
		});
		// v5: the list name moved from the membership row to the list ([D-08]).
		// Until the first cycle brings the server's name, a list keeps this
		// member's.
		this.version(5).upgrade(async (tx) => {
			const memberships = (await tx.table('memberships').toArray()) as (Membership & {
				display_name?: string;
			})[];
			for (const { display_name, ...membership } of memberships) {
				// A list without a row was never pulled, so it gets no `updated`.
				const list = (await tx.table('lists').get(membership.list)) as ListRow | undefined;
				await tx.table('lists').put({
					...list,
					id: membership.list,
					name: list?.name ?? display_name ?? ''
				});
				await tx.table('memberships').put(membership);
			}
		});
		// v6: the screens read a list's rows by where they sit ([D-308]).
		this.version(6)
			.stores({ items: 'id, list, [list+shelf+shelf_at]' })
			.upgrade((tx) =>
				tx
					.table('items')
					.toCollection()
					.modify((row: Item) => void shelve(row))
			);
		// v7: the rows density became the list density ([D-313]), so a device
		// that chose it keeps rows rather than falling back to the grid.
		this.version(7).upgrade((tx) =>
			tx
				.table('meta')
				.where('key')
				.equals('ui_density')
				.modify((row: MetaRow) => {
					if (row.value === 'rows') row.value = 'list';
				})
		);
	}
}

/** Each view table's shadow. */
export const SHADOW_TABLES = {
	items: 'server_items',
	list_categories: 'server_list_categories'
} as const;

export const db = new AppDB();

/**
 * The view table of a §8.3 push collection; the one place the cast from
 * Dexie's union of typed tables lives.
 */
export function syncTable(collection: SyncCollection): Table<Item | ListCategory, string> {
	return db[collection] as unknown as Table<Item | ListCategory, string>;
}

/** The shadow of a §8.3 push collection (see `server_items` above). */
export function shadowTable(collection: SyncCollection): Table<Item | ListCategory, string> {
	return db[SHADOW_TABLES[collection]] as unknown as Table<Item | ListCategory, string>;
}

/**
 * The view, its shadow and the outbox: what every sync transaction that applies
 * server rows opens, so none can forget the shadow.
 */
export function collectionTables(collection: SyncCollection) {
	return [syncTable(collection), shadowTable(collection), db.pending_ops];
}

/** collectionTables for both collections: what a transaction over rows of both opens. */
export function allCollectionTables() {
	return [...SYNC_COLLECTIONS.flatMap((c) => [syncTable(c), shadowTable(c)]), db.pending_ops];
}

/**
 * Every table holding the account's list data. A list's purge (sync/purge.ts)
 * deletes its rows from each; a sign-out clears them all.
 */
export function listDataTables() {
	return [...allCollectionTables(), db.lists, db.memberships, db.roster];
}

export async function getMeta<K extends MetaKey>(key: K): Promise<MetaValues[K] | undefined> {
	const row = await db.meta.get(key);
	return row?.value as MetaValues[K] | undefined;
}

/** This device's membership row for a list, the newest: one left and
 *  re-joined on another device has a second, stale row here until the next
 *  sync drops it. */
export async function ownMembership(listId: string): Promise<Membership | undefined> {
	return (await db.memberships.where('list').equals(listId).sortBy('updated')).at(-1);
}

export async function setMeta<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void> {
	await db.meta.put({ key, value });
}
