// The home screen's list order (§9.3); ListsHome owns the rendering.
import type { ListRow } from './db';
import { collator } from './i18n';
import type { ListSort } from './state/prefs';

/**
 * The user's lists — their membership rows — in the chosen order:
 * - `alphabetical`: by the list's name, locale-aware;
 * - `custom`: by the saved drag order, lists it does not know yet first;
 * - `activity` (the default): newest activity first, where activity is the
 *   list index's `updated` — the digest's max_updated, i.e. the newest item or
 *   category change on the list, not the server's lists.updated column.
 */
export function sortLists<T extends { list: string; name: string }>(
	rows: T[],
	mode: ListSort,
	order: string[],
	index: ListRow[]
): T[] {
	if (mode === 'alphabetical') {
		const coll = collator();
		return [...rows].sort((a, b) => coll.compare(a.name, b.name));
	}
	if (mode === 'custom') {
		const rank = new Map(order.map((id, i) => [id, i]));
		const rankOf = (listId: string) => rank.get(listId) ?? Number.MAX_SAFE_INTEGER;
		return [...rows].sort((a, b) => rankOf(a.list) - rankOf(b.list));
	}
	const updated = new Map(index.map((l) => [l.id, l.updated]));
	return [...rows].sort((a, b) =>
		(updated.get(b.list) ?? '').localeCompare(updated.get(a.list) ?? '')
	);
}

/**
 * The saved custom order, reconciled with the user's lists: new lists go
 * first (§9.3), ids of lists they no longer have are dropped. Null when
 * nothing changed, so the caller writes the pref only then.
 */
export function reconcileOrder(order: string[], listIds: string[]): string[] | null {
	const known = new Set(listIds);
	const missing = listIds.filter((id) => !order.includes(id));
	const kept = order.filter((id) => known.has(id));
	return missing.length > 0 || kept.length !== order.length ? [...missing, ...kept] : null;
}
