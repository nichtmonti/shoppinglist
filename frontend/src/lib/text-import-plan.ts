// What a pasted or shared text list becomes on a target list ([D-254]): one
// row per item, the aisle it lands in, and whether the list already has it.
// The review screen renders these rows and the import writes the selected
// ones, so what the screen shows is what gets written.
//
// The aisle comes from the item's own name first (the classifier the add bar
// uses, §9 [D-48]), then from the section it sat under in the source, then
// Others. The section is the second source because it is the other app's
// grouping, not ours: "[Brotaufstrich]" has no aisle here, but "Ahornsirup"
// under it may well be known by name.
//
// This module may know `classify` and the actions may not ([D-221]), so the
// rows carry resolved category ids and the actions only write them.
import type { CategoryTemplate, Item, ItemDictionary, ListCategory } from './db';
import {
	categoryName,
	categoryNameKey,
	categoryOf,
	othersCategory,
	sortCategories,
	visibleCategories
} from './categories';
import { buildCorpus, classify, foldForMatch, type Corpus } from './classify';
import { findByName } from './dedup';
import { normalizeName } from './normalize';
import { BACKUP_FORMAT, BACKUP_VERSION, byteLength, maxBytesFor } from './field-contract';
import type { ListBackup } from './backup';
import type { TextEntry } from './text-import';
import { t, type Locale } from './i18n';
import type { ItemEditPatch } from './item-edit';

export type RowStatus =
	/** Not on the list: it will be created. */
	| 'new'
	/** Checked off or in "Frühere Artikel": it comes back instead of a second row. */
	| 'reactivate'
	/** Already on the list, unchecked: nothing to do. */
	| 'on_list'
	/** Longer than an item name may be. */
	| 'too_long';

export interface PlanRow {
	/** The index of its first entry in the text, as a string: stable across
	 *  re-plans, so the review's selection and edits key on it. */
	key: string;
	name: string;
	/** The amount the text gave, '' for none ([D-20]). */
	quantity: string;
	/** A note the review added; the text carries none. */
	note: string | null;
	/** A `ListCategory.id` of the target's categories; null is Others. */
	categoryKey: string | null;
	status: RowStatus;
	/** Ticked in the source, which is why a new or returning row starts out
	 *  unselected. */
	ticked: boolean;
	/** The row a `reactivate` brings back. */
	existing?: Item;
}

export interface PlanTarget {
	categories: ListCategory[];
	items: Item[];
	dictionary: ItemDictionary[];
	templates: Map<string, CategoryTemplate>;
	/** The app's language, which picks the classifier's grammar. */
	locale: Locale;
}

/**
 * The categories a NEW list will have: the template roster create and the
 * text import both copy (§7.5), as rows whose id is the slug. The backup
 * built from the plan maps them back by that slug.
 */
export function rosterCategories(templates: CategoryTemplate[]): ListCategory[] {
	return templates
		.filter((t) => !t.retired)
		.sort((a, b) => a.sort_order - b.sort_order)
		.map((t) => ({
			id: t.slug,
			list: '',
			slug: t.slug,
			name: null,
			icon: t.icon,
			color: t.color,
			sort_order: t.sort_order,
			updated: '',
			created: '',
			deleted_at: null
		}));
}

/** "Obst - Gemüse - Nüsse", "Snacks & Süßes", "Wasch-/Putzmittel" → its parts. */
function sectionParts(section: string): string[] {
	return section
		.split(/\s+[-–—]\s+|\s*[,&+/|]\s*|\s+(?:und|and)\s+/iu)
		.map((p) => p.trim())
		.filter(Boolean);
}

/**
 * The category a source section stands for, if one of its parts names one of
 * the list's aisles ("Kühlregal" in „Milch & Kühlregal“, in either
 * language) or is itself a name the classifier knows ("Nüsse"). The first
 * part that answers wins: a section is named most-important-first.
 */
function sectionCategory(
	section: string,
	categories: ListCategory[],
	templates: Map<string, CategoryTemplate>,
	corpus: Corpus
): string | null {
	const othersId = othersCategory(categories)?.id;
	const words = new Map<string, string>();
	for (const cat of visibleCategories(categories)) {
		if (cat.id === othersId) continue;
		const names = [categoryName(cat, templates)];
		if (cat.slug && !cat.name)
			names.push(...Object.values(templates.get(cat.slug)?.name_i18n ?? {}));
		for (const name of names) {
			for (const part of sectionParts(name)) {
				for (const word of part.split(' ')) {
					const folded = foldForMatch(word);
					if (folded.length >= 3 && !words.has(folded)) words.set(folded, cat.id);
				}
			}
		}
	}
	for (const part of sectionParts(section)) {
		const named = words.get(foldForMatch(part));
		if (named) return named;
		const guessed = classify(part, corpus);
		if (guessed) return guessed;
	}
	return null;
}

/**
 * An aisle the review chose, by what it is rather than by its id, so the
 * choice carries over when the target changes ([D-254]): a seeded aisle by its
 * slug, a member's own by its name. null is Others, which every list has.
 */
export type AisleChoice = { slug: string } | { name: string } | null;

/** The choice of the aisle `key` among `categories`; undefined for none of them. */
export function aisleChoice(
	key: string | null,
	categories: ListCategory[]
): AisleChoice | undefined {
	if (key === null) return null;
	const category = categories.find((c) => c.id === key);
	if (category?.slug) return { slug: category.slug };
	return category?.name ? { name: category.name } : undefined;
}

/** The id `choice` names among `categories`; undefined when they have no such aisle. */
function chosenKey(choice: AisleChoice, categories: ListCategory[]): string | null | undefined {
	if (choice === null) return null;
	const same = (c: ListCategory) =>
		'slug' in choice
			? c.slug === choice.slug
			: c.slug === null &&
				c.name !== null &&
				categoryNameKey(c.name) === categoryNameKey(choice.name);
	return categories.find((c) => c.deleted_at === null && same(c))?.id;
}

/**
 * What the review changed on one row, by the row's key: its tick, and the
 * item sheet's fields ([D-254]). An absent field keeps what the text and the
 * plan say; an aisle the target does not have falls back to the plan's.
 */
export interface RowEdit {
	selected?: boolean;
	name?: string;
	quantity?: string;
	note?: string | null;
	aisle?: AisleChoice;
}

/**
 * `edit` with the item sheet's or the quantity control's `patch` folded in.
 * The aisle is kept by what it is, so it carries over to another target; an
 * aisle `categories` does not have leaves the edit's as it was.
 */
export function withPatch(
	edit: RowEdit | undefined,
	patch: ItemEditPatch,
	categories: ListCategory[]
): RowEdit {
	const next: RowEdit = { ...edit };
	if (patch.name !== undefined) next.name = patch.name;
	if (patch.quantity !== undefined) next.quantity = patch.quantity;
	if (patch.note !== undefined) next.note = patch.note;
	if (patch.category_key !== undefined) {
		const aisle = aisleChoice(patch.category_key, categories);
		if (aisle !== undefined) next.aisle = aisle;
	}
	return next;
}

/**
 * The rows for `entries` on `target`, with the review's `edits` applied. A
 * name the text repeats is one row, keyed by its first entry's index, so a
 * row keeps its key, its selection and its edits however often the plan is
 * remade. An entry ticked in the source starts unselected: the other app says
 * it is bought. A renamed row is matched against the list by its new name.
 */
export function planImport(
	entries: TextEntry[],
	target: PlanTarget,
	edits: ReadonlyMap<string, RowEdit> = new Map()
): PlanRow[] {
	const corpus = buildCorpus(target.dictionary, target.items, target.categories, target.locale);
	const sections = new Map<string, string | null>();
	const nameCap = maxBytesFor('items', 'name');
	const quantityCap = maxBytesFor('items', 'quantity');
	const seen = new Set<string>();
	const rows: PlanRow[] = [];

	for (const [index, source] of entries.entries()) {
		const key = String(index);
		const edit = edits.get(key) ?? {};
		const entry = {
			...source,
			name: edit.name ?? source.name,
			quantity: edit.quantity ?? source.quantity
		};
		const note = edit.note ?? null;
		const normalized = normalizeName(entry.name);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);

		let categoryKey = classify(entry.name, corpus);
		if (!categoryKey && entry.section) {
			if (!sections.has(entry.section)) {
				sections.set(
					entry.section,
					sectionCategory(entry.section, target.categories, target.templates, corpus)
				);
			}
			categoryKey = sections.get(entry.section) ?? null;
		}
		const choice = edit.aisle === undefined ? undefined : chosenKey(edit.aisle, target.categories);
		const chosen = choice !== undefined;
		if (chosen) categoryKey = choice;

		const base = { key, name: entry.name, quantity: entry.quantity, note, ticked: entry.checked };
		if (
			(nameCap !== undefined && byteLength(entry.name) > nameCap) ||
			(quantityCap !== undefined && byteLength(entry.quantity) > quantityCap)
		) {
			rows.push({ ...base, categoryKey, status: 'too_long' });
			continue;
		}
		// An existing row keeps its own aisle, unless the review chose one.
		const existing = findByName(target.items, entry.name);
		if (existing && existing.deleted_at === null && !existing.checked) {
			rows.push({
				...base,
				categoryKey: existing.category_key,
				status: 'on_list'
			});
		} else if (existing) {
			rows.push({
				...base,
				categoryKey: chosen ? categoryKey : existing.category_key,
				status: 'reactivate',
				existing
			});
		} else {
			rows.push({ ...base, categoryKey, status: 'new' });
		}
	}
	return rows;
}

/** Whether the review offers `row`: one the import would create or bring back. */
export function selectable(row: PlanRow): boolean {
	return row.status === 'new' || row.status === 'reactivate';
}

/** Whether `row` is imported: offered, and ticked by the review (`edit`), or
 *  else not ticked in the source. */
export function isSelected(row: PlanRow, edit: RowEdit | undefined): boolean {
	return selectable(row) && (edit?.selected ?? !row.ticked);
}

/** The line under a row that says why it is not offered, or why it starts unticked. */
export function statusNote(row: PlanRow): string | null {
	if (row.status === 'on_list') return t('import_status_on_list');
	if (row.status === 'too_long') return t('import_status_too_long');
	if (row.status === 'reactivate') return t('import_status_reactivate');
	return row.ticked ? t('import_status_ticked') : null;
}

/** A plan row as the list view's components take it: an item on `list` that exists nowhere. */
export function rowAsItem(row: PlanRow, list: string): Item {
	return {
		id: `import-${row.key}`,
		list,
		name: row.name,
		name_de: null,
		name_en: null,
		quantity: row.quantity,
		note: row.note,
		category_key: row.categoryKey,
		checked: false,
		checked_at: null,
		last_bought_at: null,
		barcode: null,
		image_url: null,
		modified_by: null,
		updated: '',
		created: '',
		deleted_at: null
	};
}

/** The rows under the aisle each lands in, in the list's aisle order; source order within one. */
export function groupRows(
	rows: PlanRow[],
	categories: ListCategory[],
	templates: Map<string, CategoryTemplate>
): { category: ListCategory; rows: PlanRow[] }[] {
	const buckets = new Map<string, PlanRow[]>();
	for (const row of rows) {
		const category = categoryOf({ category_key: row.categoryKey }, categories);
		if (!category) continue;
		const bucket = buckets.get(category.id);
		if (bucket) bucket.push(row);
		else buckets.set(category.id, [row]);
	}
	return sortCategories(visibleCategories(categories), templates)
		.filter((category) => buckets.has(category.id))
		.map((category) => ({ category, rows: buckets.get(category.id)! }));
}

/**
 * The backup document a NEW list is imported from (§7.5 [D-72]): the template
 * roster, as create seeds it, and the chosen rows of a plan made against
 * `rosterCategories`. Going through the backup route keeps one way a
 * populated list is made, and every check that route makes.
 */
export function backupFromPlan(
	name: string,
	rows: PlanRow[],
	templates: CategoryTemplate[]
): ListBackup {
	const roster = rosterCategories(templates);
	const keyBySlug = new Map(roster.map((c, i) => [c.id, `c${i}`]));
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exported_at: new Date().toISOString(),
		display_name: name,
		categories: roster.map((c, i) => ({
			key: `c${i}`,
			slug: c.slug,
			name: null,
			icon: c.icon,
			color: c.color,
			sort_order: c.sort_order
		})),
		items: rows
			.filter((r) => r.status === 'new')
			.map((r) => ({
				name: r.name,
				quantity: r.quantity,
				note: r.note,
				category_key: r.categoryKey === null ? null : (keyBySlug.get(r.categoryKey) ?? null),
				barcode: null,
				image_url: null,
				checked: false
			}))
	};
}
