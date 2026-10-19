// What the add field decides, without a DOM (§9, §9.1); AddBar owns the
// input, focus and the combobox.
import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
import { displayName } from '#lib/item-name.js';
import { lastBoughtLabel } from '#lib/sorting.js';
import { categoryName, categoryOf, othersCategory } from '#lib/categories.js';
import { normalizeName } from '#lib/normalize.js';
import { classify, type Corpus } from '#lib/classify.js';
import { matchedPrefixLength, type DictIndexEntry, type Ranked } from '#lib/typeahead.js';
import { readTypedAmount, type Amounted } from '#lib/amount.js';
import { findByName } from '#lib/dedup.js';

/** Starts the as-typed row's key; never collides with a suggestion key
 *  (normalized names / item ids). */
const TYPED_PREFIX = '__typed__';

export interface Suggestion {
	key: string;
	name: string;
	/** The category's icon; empty when it has none (CategoryIcon draws the fallback). */
	icon: string;
	color: string;
	categoryLabel: string;
	/** The list's category-row slug to resolve on create — dictionary hits only. */
	categorySlug: string | null;
	/** §6.10's "last bought", for this list's picks only ([D-18]); null for a
	 *  dictionary hit or a name with no purchase stamp. */
	when: string | null;
	/** How many leading characters of `name` the query matched (bolded); 0 for
	 *  a synonym hit ("Rahm" → Sahne). */
	matchLength: number;
	/** The as-typed add: no ✕, since there is no name to suppress yet. */
	typed?: true;
}

export interface ListContext {
	categories: ListCategory[];
	templates: Map<string, CategoryTemplate>;
}

/** The list's own live category row for a slug, if it has one. */
function categoryForSlug(slug: string | null, categories: ListCategory[]) {
	return slug ? categories.find((c) => c.deleted_at === null && c.slug === slug) : undefined;
}

function shown(cat: ListCategory | undefined, ctx: ListContext) {
	return {
		icon: cat?.icon ?? '',
		color: cat?.color ?? 'gray',
		categoryLabel: cat ? categoryName(cat, ctx.templates) : ''
	};
}

/**
 * The §9 ranking (#lib/typeahead), resolved into dropdown rows. Takes only the
 * ranked survivors, since resolving a row scans the category rows. `now` is the
 * caller's clock, so "heute"/"gestern" re-derives at midnight.
 */
export function resolveSuggestions(
	ranked: Ranked[],
	q: string,
	now: number,
	ctx: ListContext
): Suggestion[] {
	return ranked.map((r) => {
		if (r.kind === 'dict') {
			// A dictionary hit shows in the list's row for its slug, else Others (§6.6).
			const cat = categoryForSlug(r.slug, ctx.categories) ?? othersCategory(ctx.categories);
			return {
				key: r.key,
				name: r.display,
				...shown(cat, ctx),
				categorySlug: r.slug,
				when: null,
				matchLength: matchedPrefixLength(r.display, q)
			};
		}
		const name = displayName(r.item);
		return {
			key: normalizeName(name),
			name,
			...shown(categoryOf(r.item, ctx.categories), ctx),
			categorySlug: null,
			when: lastBoughtLabel(r.item, now),
			matchLength: matchedPrefixLength(name, q)
		};
	});
}

/**
 * The category an add lands in. A selected dictionary hit keeps its own
 * aisle; the head-noun classifier (§9 [D-48]) fills only what would
 * otherwise be null (Others).
 */
function categoryKeyForAdd(
	name: string,
	dictSlug: string | null,
	categories: ListCategory[],
	corpus: Corpus
): string | null {
	return categoryForSlug(dictSlug, categories)?.id ?? classify(name, corpus);
}

/**
 * The dropdown's rows: the suggestions, then the as-typed add, drawn as one
 * more candidate with the aisle an add of it takes (§9 [D-48], [D-332]). Left
 * out when a suggestion is the typed name already, since a second row for it
 * read as two items ([D-305]).
 *
 * Its key changes with the suggestions above it: bits-ui re-highlights the
 * first candidate only when an item mounts while the highlighted node has left
 * the document, so a suggestion arriving after the keystroke (a late live
 * query, a sync push) takes the highlight only if the as-typed row remounts.
 */
export function withTypedCandidate(
	suggestions: Suggestion[],
	typedName: string,
	corpus: Corpus,
	ctx: ListContext
): Suggestion[] {
	const key = normalizeName(typedName);
	if (!typedName.trim() || suggestions.some((s) => normalizeName(s.name) === key)) {
		return suggestions;
	}
	const cat = categoryOf({ category_key: classify(typedName.trim(), corpus) }, ctx.categories);
	const typed: Suggestion = {
		key: TYPED_PREFIX + suggestions.map((s) => s.key).join('\u0000'),
		name: typedName,
		...shown(cat, ctx),
		categorySlug: null,
		when: null,
		matchLength: typedName.length,
		typed: true
	};
	return [...suggestions, typed];
}

/** The name an add would commit, or null when there is nothing to add (only
 *  whitespace, or nothing left after normalizing). */
export function addableName(rawName: string): string | null {
	const name = rawName.trim();
	return name && normalizeName(name) ? name : null;
}

export type AddPlan =
	/** §9.1: an active match jumps, a checked or remembered one re-activates. */
	{ kind: 'existing'; item: Item } | { kind: 'create'; name: string; categoryKey: string | null };

/** What adding an `addableName()` does to this list. */
export function planAdd(
	name: string,
	dictSlug: string | null,
	items: Item[],
	categories: ListCategory[],
	corpus: Corpus
): AddPlan {
	const existing = findByName(items, name);
	if (existing) return { kind: 'existing', item: existing };
	return {
		kind: 'create',
		name,
		categoryKey: categoryKeyForAdd(name, dictSlug, categories, corpus)
	};
}

/**
 * Every normalized name the dictionary (in this locale) or the list holds, so
 * a typed name that is one of them keeps its number ("Tempo 100", [D-285]).
 * Built when the dictionary or the list changes, not per keystroke.
 */
export function knownNameKeys(
	dictIndex: DictIndexEntry[],
	rowsByKey: Map<string, Item>
): Set<string> {
	const keys = new Set(rowsByKey.keys());
	for (const entry of dictIndex) for (const form of entry.forms) keys.add(form);
	return keys;
}

/** The typed text as a name and the amount written with it ([D-285]). */
export function typedAmount(query: string, known: Set<string>): Amounted {
	return readTypedAmount(query, (name) => known.has(normalizeName(name)));
}
