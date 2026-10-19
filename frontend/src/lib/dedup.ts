// The "is it already on the list?" check (§9.1, §9.2), shared by the typeahead
// and the scanner. It matches on the [D-44] canonical form the server merges on
// (§8.3 [D-29]), widened only by a scanned item's localized names ([D-21]): the
// client may jump to a row the server would not merge into, never the reverse,
// which is the direction that duplicates rows.
import type { Item } from './db';
import { nameKeys } from './item-name';
import { normalizeName } from './normalize';

/**
 * The first LIVING match, else the first removed row the list still remembers
 * buying ([D-18]). Living wins regardless of position: when two same-name rows
 * coexist (a concurrent insert, §8.3), restoring the tombstone would put a
 * second row of that name on the list. The server merge ranks the same way.
 */
function firstMatch(items: Item[], matches: (i: Item) => boolean): Item | undefined {
	let remembered: Item | undefined;
	for (const item of items) {
		if (!matches(item)) continue;
		if (item.deleted_at === null) return item;
		if (!remembered && item.last_bought_at !== null) remembered = item;
	}
	return remembered;
}

/**
 * An existing item on this list with the same name: active, checked, or a
 * removed row the list still remembers buying (§6.10). `applyDedupHit` acts on
 * it.
 */
export function findByName(items: Item[], name: string): Item | undefined {
	const key = normalizeName(name);
	if (!key) return undefined;
	return firstMatch(items, (i) => nameKeys(i).includes(key));
}

/**
 * Whether a row in `items` other than `exceptId` answers to `name`: a rename
 * into it would show the name twice, since the server merges only an add
 * (§8.3). The caller passes the rows that count (the list's living ones).
 */
export function nameTakenBy(items: Item[], name: string, exceptId: string): boolean {
	const key = normalizeName(name);
	return items.some((other) => other.id !== exceptId && nameKeys(other).includes(key));
}

/** Scan-dedup (§9.2): the same EAN already on the list. */
export function findByBarcode(items: Item[], barcode: string): Item | undefined {
	if (!barcode) return undefined;
	return firstMatch(items, (i) => i.barcode === barcode);
}
