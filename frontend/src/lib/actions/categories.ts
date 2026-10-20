// Every mutation of `list_categories` goes through this module, for the reason
// #lib/actions/items.ts gives ([D-40]). A reorder is per-row updates, not one
// batched op: §6.7 accepts that under the §8 merge, and the outbox coalesces
// repeated edits to a row (§8.2).
import { v4 } from 'uuid';
import { collectionTables, db, type ListCategory } from '#lib/db.js';
import { pb } from '#lib/pb.js';
import {
	createRecord,
	deleteRecord,
	pullFromServer,
	restoreRecord,
	updateRecord
} from '#lib/sync/index.js';
import { OTHERS_SLUG } from '#lib/categories.js';
import { showToast } from '#lib/toasts.js';
import { t } from '#lib/i18n/index.js';
import { serialQueue } from '#lib/serial.js';

export interface NewCategoryFields {
	name: string;
	icon: string;
	color: string;
	sort_order: number;
}

/** Add a custom category (§6.7: "a member-added custom category"). `slug` stays null. */
export async function addCategory(listId: string, fields: NewCategoryFields): Promise<string> {
	const id = v4();
	// No `slug`, not even null: it is server-owned ([D-08]), and naming it makes
	// the server deny the whole create as field_unknown.
	await createRecord('list_categories', listId, id, {
		name: fields.name,
		icon: fields.icon,
		color: fields.color,
		sort_order: fields.sort_order
	});
	return id;
}

/** Rename / re-emoji / recolor / reorder. Others may take all of these (§6.7 [D-30]). */
export async function editCategory(
	category: ListCategory,
	fields: Partial<Pick<ListCategory, 'name' | 'icon' | 'color' | 'sort_order'>>
): Promise<void> {
	const changed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== category[key as keyof ListCategory]) changed[key] = value;
	}
	if (Object.keys(changed).length === 0) return;
	await updateRecord('list_categories', category, changed);
}

/** "Reset to default" (§6.7): clears the custom name and restores the template's icon/color. */
export async function resetCategoryToTemplate(
	category: ListCategory,
	template: { icon: string; color: string }
): Promise<void> {
	await updateRecord('list_categories', category, {
		name: null,
		icon: template.icon,
		color: template.color
	});
}

/**
 * Hide a category (tombstone). `label` is the name the row shows (an unrenamed
 * seeded row has none of its own, §6.7). The Others row can never be
 * tombstoned — the server denies it ([D-30], §8.3) and the UI must not even
 * offer the action.
 */
export async function hideCategory(category: ListCategory, label: string): Promise<void> {
	if (category.slug === OTHERS_SLUG) {
		throw new Error('the Others category cannot be hidden');
	}
	await deleteRecord('list_categories', category);
	// §9.1's safety net at the moment of action, as in removeItem. A toast, not
	// a confirm: the hidden category's items only fall to Others (§6.6).
	showToast(t('categories_hidden_toast', { name: label }), async () => {
		const current = await db.list_categories.get(category.id);
		if (current) await restoreRecord('list_categories', current);
	});
}

/** Restore a hidden category from the editor's hidden-categories section. */
export async function restoreCategory(category: ListCategory): Promise<void> {
	await restoreRecord('list_categories', category);
}

// ---- drag-to-reorder (§6.7) ----

// One reorder at a time, each computed against the order when it runs: two
// quick arrow taps ([D-90]) would otherwise both start from the same stale
// order and the second would be lost.
const reorderQueue = serialQueue();

/**
 * Persist a reorder (the new id order from a drop or an arrow move), queued
 * behind any reorder still running. The rows' current sort_orders are re-read
 * and handed out again in the new order, the i-th smallest to the i-th row, so
 * only rows that move are written. A value tied with the one before it is
 * lifted just above it: two categories added on two devices can share one, and
 * handing equal values around would leave their order as it was. `visible`
 * only names the rows and breaks sort_order ties.
 */
export function persistReorder(visible: ListCategory[], newOrder: string[]): Promise<void> {
	// One transaction, so only the end state renders.
	return reorderQueue(() =>
		db.transaction('rw', collectionTables('list_categories'), async () => {
			const shown = new Map(visible.map((c, i) => [c.id, i]));
			const fresh = (await db.list_categories.bulkGet(visible.map((c) => c.id)))
				.filter((c): c is ListCategory => c !== undefined)
				.sort((a, b) => a.sort_order - b.sort_order || shown.get(a.id)! - shown.get(b.id)!);
			const byId = new Map(fresh.map((c) => [c.id, c]));
			const order = newOrder.filter((id) => byId.has(id));
			for (const c of fresh) if (!order.includes(c.id)) order.push(c.id);
			let previous = -Infinity;
			for (const [i, id] of order.entries()) {
				const value = Math.max(fresh[i].sort_order, previous + 1);
				previous = value;
				const row = byId.get(id)!;
				if (row.sort_order !== value) await editCategory(row, { sort_order: value });
			}
		})
	);
}

/**
 * [D-251] `POST /api/lists/{listId}/categories/missing`: adds the template
 * aisles the list has no row for, a removed one excepted, with their slugs,
 * which only the server sets ([D-08]). Online-only, like the other server
 * routes; the new rows arrive through the sync cycle it starts. Resolves to
 * the slugs added.
 */
export async function addMissingCategories(listId: string): Promise<string[]> {
	const { added } = await pb.send<{ added: string[] }>(`/api/lists/${listId}/categories/missing`, {
		method: 'POST'
	});
	await pullFromServer();
	return added;
}
