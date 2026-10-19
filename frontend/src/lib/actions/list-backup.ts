// The Dexie half of a per-list backup ([D-72]): the list's rows as the device
// holds them, shaped by #lib/backup, which stays pure.
import { db } from '#lib/db.js';
import {
	backupDocument,
	type BackupCategory,
	type BackupItem,
	type ListBackup
} from '#lib/backup.js';

/**
 * Build a backup document for one list: tombstones dropped, category ids mapped
 * to file-local keys (`c0…cN`) in sort order, so the file carries no server ids.
 */
export async function buildListBackup(listId: string): Promise<ListBackup> {
	const [categories, items, list] = await Promise.all([
		db.list_categories.where('list').equals(listId).toArray(),
		db.items.where('list').equals(listId).toArray(),
		db.lists.get(listId)
	]);

	const livingCategories = categories
		.filter((c) => c.deleted_at === null)
		.sort(
			(a, b) =>
				a.sort_order - b.sort_order ||
				a.created.localeCompare(b.created) ||
				a.id.localeCompare(b.id)
		);

	const keyById = new Map<string, string>();
	const backupCategories: BackupCategory[] = livingCategories.map((c, i) => {
		const key = `c${i}`;
		keyById.set(c.id, key);
		return {
			key,
			slug: c.slug,
			name: c.name,
			icon: c.icon,
			color: c.color,
			sort_order: c.sort_order
		};
	});

	// A deterministic order makes round-trip tests exact.
	const livingItems = items
		.filter((i) => i.deleted_at === null)
		.sort((a, b) => a.name.localeCompare(b.name, 'de') || a.created.localeCompare(b.created));

	const backupItems: BackupItem[] = livingItems.map((i) => ({
		name: i.name,
		...(i.name_de ? { name_de: i.name_de } : {}),
		...(i.name_en ? { name_en: i.name_en } : {}),
		quantity: i.quantity,
		note: i.note,
		// A tombstoned category (not in the map) degrades to null, not dangling.
		category_key: i.category_key === null ? null : (keyById.get(i.category_key) ?? null),
		barcode: i.barcode,
		image_url: i.image_url,
		checked: i.checked,
		...(i.checked && i.checked_at ? { checked_at: i.checked_at } : {}),
		...(i.last_bought_at !== null ? { last_bought_at: i.last_bought_at } : {})
	}));

	return backupDocument(list?.name ?? '', backupCategories, backupItems);
}
