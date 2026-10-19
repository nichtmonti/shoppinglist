// The §9 typeahead ranking: which names appear and in what order. AddBar owns
// the rendering.
import type { Item, ItemDictionary } from './db';
import { collator, type Locale } from './i18n';
import { nameKeys } from './item-name';
import { normalizeName } from './normalize';
import { byUpdatedDesc } from './sorting';

/** One dictionary entry, normalized once per dictionary/locale change. */
export interface DictIndexEntry {
	display: string;
	key: string;
	slug: string | null;
	popularity: number;
	/** Every localized name of the entry, normalized — what the prefix match reads. */
	forms: string[];
}

export type Ranked =
	| { kind: 'dict'; key: string; display: string; slug: string | null }
	| { kind: 'pick'; key: string; item: Item };

/** How many suggestions the dropdown shows. */
const SUGGESTION_LIMIT = 8;

/**
 * The typeahead's dictionary index. Build it when the dictionary or the locale
 * changes, never per keystroke: normalizing every name per keystroke costs tens
 * of ms on a phone, in the input frame.
 */
export function buildDictIndex(dictionary: ItemDictionary[], locale: Locale): DictIndexEntry[] {
	const index: DictIndexEntry[] = [];
	for (const entry of dictionary) {
		const names = entry.names_i18n[locale] ?? entry.names_i18n.en ?? [];
		if (names.length === 0) continue;
		index.push({
			display: names[0],
			key: normalizeName(names[0]),
			slug: entry.default_category,
			popularity: entry.popularity,
			forms: names.map((n) => normalizeName(n))
		});
	}
	return index;
}

/**
 * The list's rows by normalized name, keeping the most recently touched row of
 * each (§9). A scanned row is filed under each of its names ([D-21]).
 */
export function latestRowByKey(items: Item[]): Map<string, Item> {
	const latest = new Map<string, Item>();
	for (const item of items) {
		for (const key of nameKeys(item)) {
			const prev = latest.get(key);
			if (!prev || item.updated > prev.updated) latest.set(key, item);
		}
	}
	return latest;
}

/**
 * The §9 ranking for a normalized query `q`, in two tiers: this list's own
 * rows, newest first; then dictionary entries with no row here, by popularity,
 * then alphabetically. Within each tier a direct prefix match precedes a
 * synonym-only one ("Rahm" offers Rahmspinat before Sahne). The name typed
 * exactly leads both tiers.
 *
 * A row also matches through the dictionary entry it shares a name with, so a
 * bought "Sahne" is offered for "Rahm" as the row, not as a dictionary hit.
 *
 * Dedup runs before suppression and the cap: a suppressed name hides both its
 * dictionary entry and the list's row for it (§6.11), and costs no slot.
 */
export function rankSuggestions(
	q: string,
	dictIndex: DictIndexEntry[],
	rows: Map<string, Item>,
	suppressed: readonly string[],
	limit: number = SUGGESTION_LIMIT
): Ranked[] {
	if (!q) return [];

	const hits = dictIndex.filter((e) => e.forms.some((n) => n.startsWith(q)));

	// Rows matching on their own name, plus rows standing in for a hit.
	const matchedRows = [...rows].filter(([key]) => key.startsWith(q));
	for (const hit of hits) {
		const row = rows.get(hit.key);
		if (row && !hit.key.startsWith(q)) matchedRows.push([hit.key, row]);
	}
	matchedRows.sort(([ka, a], [kb, b]) => byDirectMatch(ka, kb, q) || byUpdatedDesc(a, b));

	const dictOnly = hits
		.filter((e) => !rows.has(e.key))
		.sort(
			(a, b) =>
				byDirectMatch(a.key, b.key, q) ||
				b.popularity - a.popularity ||
				collator().compare(a.display, b.display)
		);

	// A row filed under several names ([D-21]) is offered once, and every one
	// of its names is spent, so no dictionary entry offers it again.
	const seen = new Set<string>();
	const seenRows = new Set<string>();
	const ranked: Ranked[] = [];
	for (const [key, item] of matchedRows) {
		if (seen.has(key) || seenRows.has(item.id)) continue;
		seenRows.add(item.id);
		for (const k of nameKeys(item)) seen.add(k);
		seen.add(key);
		ranked.push({ kind: 'pick', key, item });
	}
	for (const hit of dictOnly) {
		if (seen.has(hit.key)) continue;
		seen.add(hit.key);
		ranked.push({ kind: 'dict', key: hit.key, display: hit.display, slug: hit.slug });
	}

	// The name typed exactly comes first, row or dictionary entry: Enter takes
	// the top match (§9), and "Milch" must not add a newer "Milchschokolade".
	const exact = ranked.findIndex((r) =>
		r.kind === 'pick' ? nameKeys(r.item).includes(q) : r.key === q
	);
	if (exact > 0) ranked.unshift(...ranked.splice(exact, 1));

	// A row is hidden when ANY of its names is: hiding what you see must not
	// leave the row reachable through the name you don't ([D-21]).
	const isSuppressed = (r: Ranked): boolean =>
		r.kind === 'pick'
			? nameKeys(r.item).some((k) => suppressed.includes(k))
			: suppressed.includes(r.key);
	return ranked.filter((r) => !isSuppressed(r)).slice(0, limit);
}

/** Sort comparator: a name that itself starts with `q` before a synonym-only match. */
function byDirectMatch(a: string, b: string, q: string): number {
	return Number(b.startsWith(q)) - Number(a.startsWith(q));
}

/**
 * The shortest prefix of `name` that normalizes to `q`, or 0 when the name does
 * not start with it: how much of a suggestion to bold. Not `q.length`, because
 * normalization can make the two lengths differ, and a synonym hit matched
 * another word.
 */
export function matchedPrefixLength(name: string, q: string): number {
	if (!q || !normalizeName(name).startsWith(q)) return 0;
	for (let i = 1; i <= name.length; i++) {
		if (normalizeName(name.slice(0, i)) === q) return i;
	}
	return 0;
}
