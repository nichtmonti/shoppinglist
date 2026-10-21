// Test helpers for the Dexie-backed component tests.
//
// `db` is a module singleton opened against the fake-indexeddb the setup files
// install, so tests share one database. Reset it between tests, and build rows
// with the factories below rather than hand-writing object literals — a missing
// field (a null `deleted_at`, an absent `checked_at`) is exactly the kind of
// difference that makes a view test pass against data the app never produces.
import {
	allCollectionTables,
	collectionTables,
	db,
	shadowTable,
	type CategoryTemplate,
	type Item,
	type ListCategory,
	type Membership,
	type PendingOp
} from '#lib/db.js';
import { recompute } from '#lib/sync/apply.js';
import { shadowFromLocal } from '#lib/sync/shadow.js';
import { shelve, stampsFromRow } from '#lib/sync/materialize.js';
import { invalidateLiveCaches, type LiveStore } from '#lib/state/live.js';
import { get } from 'svelte/store';
import { vi } from 'vitest';

/** A fresh device: empty tables, and no store value read before ([D-205]). */
export async function resetDb(): Promise<void> {
	await Promise.all(db.tables.map((table) => table.clear()));
	invalidateLiveCaches();
}

/**
 * Resolve once every store's FIRST Dexie emission has landed — `live()`'s
 * `loaded` flag flips on precisely that emission (see state/live.ts), so this
 * waits for the hydration event itself rather than guessing at its timing.
 *
 * The stores are factories (`listOpenItems(listId)` builds a fresh liveQuery per
 * call), so the instance waited on here is a PARALLEL instance running the
 * identical query — the component's own subscription starts at mount, no
 * later than this one, with the same cold-start cost. What this proves:
 * a real query over the same table has delivered. What it cannot prove
 * (nothing external can): the component's private copy.
 */
export async function untilLoaded(...stores: LiveStore<unknown>[]): Promise<void> {
	// Subscribed for the wait: a subscription is what runs each query.
	const unsubs = stores.map((store) => store.loaded.subscribe(() => {}));
	try {
		await vi.waitUntil(() => stores.every((store) => get(store.loaded)), { timeout: 5000 });
	} finally {
		for (const unsub of unsubs) unsub();
	}
}

let seq = 0;

export function makeItem(overrides: Partial<Item> & { list: string; name: string }): Item {
	const now = new Date().toISOString();
	return {
		id: `item-${++seq}`,
		name_de: null,
		name_en: null,
		quantity: '',
		note: null,
		category_key: null,
		checked: false,
		checked_at: null,
		last_bought_at: null,
		barcode: null,
		image_url: null,
		modified_by: null,
		updated: now,
		created: now,
		deleted_at: null,
		...overrides
	};
}

export function makeCategory(overrides: Partial<ListCategory> & { list: string }): ListCategory {
	const now = new Date().toISOString();
	return {
		id: `cat-${++seq}`,
		slug: null,
		name: 'Kategorie',
		icon: '🛒',
		color: 'green',
		sort_order: 1,
		updated: now,
		created: now,
		deleted_at: null,
		...overrides
	};
}

export function makeTemplate(
	overrides: Partial<CategoryTemplate> & { slug: string }
): CategoryTemplate {
	return {
		name_i18n: { de: 'Sonstiges', en: 'Other' },
		icon: '📦',
		color: 'gray',
		sort_order: 17,
		retired: false,
		...overrides
	};
}

export function makeMembership(overrides: Partial<Membership> & { list: string }): Membership {
	const now = new Date().toISOString();
	return {
		id: `mem-${++seq}`,
		account: 'account-1',
		created: now,
		updated: now,
		...overrides
	};
}

/**
 * A list this account is on: its membership row and its lists row, which
 * carries the name ([D-08]). Returns the membership.
 */
export async function putMyList(
	listId: string,
	name: string,
	overrides: Partial<Membership> & { updated?: string } = {}
): Promise<Membership> {
	const { updated, ...membership } = overrides;
	const row = makeMembership({ list: listId, ...membership });
	await db.memberships.put(row);
	await db.lists.put({ id: listId, name, updated: updated ?? new Date().toISOString() });
	return row;
}

/** Seed a list's rows in one call. */
export async function seedList(options: {
	listId: string;
	name?: string;
	items?: Item[];
	categories?: ListCategory[];
	templates?: CategoryTemplate[];
}): Promise<void> {
	const { listId, name = 'Wochenshop', items = [], categories = [], templates = [] } = options;
	await putMyList(listId, name);
	await putSynced(items, categories);
	if (templates.length) await db.category_templates.bulkPut(templates);
}

/**
 * Rows this device has synced: each in its view table AND its shadow, as a
 * snapshot would leave them. A row put into the view alone is one the server
 * does not have — the engine's next recompute of it removes it.
 */
export async function putSynced(
	items: Item[] = [],
	categories: ListCategory[] = []
): Promise<void> {
	await db.transaction('rw', allCollectionTables(), async () => {
		await db.items.bulkPut(items.map((item) => shelve({ ...item })));
		await db.server_items.bulkPut(items);
		await db.list_categories.bulkPut(categories);
		await db.server_list_categories.bulkPut(categories);
	});
}

/** A synced row changed by a server write (a co-member's edit): view and shadow. */
export async function updateSynced(id: string, changes: Partial<Item>): Promise<void> {
	const row = await db.items.get(id);
	if (!row) return;
	const synced: Item = { ...row, ...changes };
	delete synced.shelf; // the view's own, never the server's
	delete synced.shelf_at;
	await putSynced([synced]);
}

/**
 * Queue an op for a row seeded with its LOCAL values — the row as the user
 * sees it, the op's edits already applied. The row's shadow takes the server half the
 * op implies (shadowFromLocal, the v3 migration's rule, keeping `updated`), the
 * op takes its optimistic stamps off the row (the v4 migration's rule), and
 * the row is recomputed from the two — so view, shadow and op agree the way
 * the engine keeps them.
 */
export async function queueOp(op: PendingOp): Promise<void> {
	const collection = op.collection;
	await db.transaction('rw', collectionTables(collection), async () => {
		const row = await db[collection].get(op.record_id);
		const stamps =
			op.stamps ?? (row ? stampsFromRow(row as unknown as Record<string, unknown>) : {});
		await db.pending_ops.put({ ...op, stamps: { ...stamps } });
		if (row) {
			const shadow = shadowFromLocal(row, op);
			if (shadow) await shadowTable(collection).put({ ...shadow, updated: row.updated });
			else await shadowTable(collection).delete(op.record_id);
		}
		await recompute(collection, [op.record_id]);
	});
}
