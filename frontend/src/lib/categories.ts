// Category rendering rules (§6.7, §9, [D-37]), the one definition every
// category surface renders from.
import type { CategoryTemplate, Item, ListCategory } from './db';
import { collator, localized, type MessageKey } from './i18n';

/**
 * The curated palette [D-37], mapped to CSS in src/app.css. The editor's picker
 * offers it, and an unknown incoming token renders as gray rather than as an
 * undefined custom property.
 */
export const PALETTE = [
	'green',
	'amber',
	'sky',
	'red',
	'olive',
	'yellow',
	'violet',
	'orange',
	'pink',
	'cyan',
	'teal',
	'wine',
	'slate',
	'lavender',
	'brown',
	'blue',
	'steel',
	'lime',
	'indigo',
	'magenta',
	'gray'
] as const;

export type PaletteToken = (typeof PALETTE)[number];

/** The slug of the permanent fallback bucket — never hideable, always last [D-30]. */
export const OTHERS_SLUG = 'other';

export function isPaletteToken(color: string): color is PaletteToken {
	return (PALETTE as readonly string[]).includes(color);
}

/** The CSS custom-property reference for a palette token (gray if unknown). */
export function categoryColorVar(color: string | null | undefined): string {
	return `var(--cat-${isPaletteToken(color ?? '') ? color : 'gray'})`;
}

/**
 * The inline style every category-tinted surface takes: `--c` is the tint the
 * `cat-*` utilities in app.css mix in.
 */
export function categoryStyle(color: string | null | undefined): string {
	return `--c: ${categoryColorVar(color)}`;
}

/**
 * A category's display label (§6.7): a set `name` wins; otherwise the
 * template's localized default via `slug`; otherwise the slug itself.
 */
export function categoryName(
	category: Pick<ListCategory, 'name' | 'slug'>,
	templates: Map<string, CategoryTemplate>
): string {
	if (category.name) return category.name;
	if (!category.slug) return '';
	return localized(templates.get(category.slug)?.name_i18n, category.slug);
}

/**
 * A seeded row's localized template name, ignoring any rename; '' for a
 * member-added row or an unknown template. The editor's reset hint and
 * placeholder.
 */
export function templateDefaultName(
	category: Pick<ListCategory, 'slug'>,
	templates: Map<string, CategoryTemplate>
): string {
	if (!category.slug) return '';
	const template = templates.get(category.slug);
	return template ? localized(template.name_i18n, category.slug) : '';
}

/**
 * The `name` an edit saves. A blank draft on a seeded row resets it to the
 * template default (null); a member-added row has no default, so blanking it
 * keeps its name.
 */
export function editedCategoryName(
	draft: string,
	category: Pick<ListCategory, 'name' | 'slug'>
): string | null {
	const trimmed = draft.trim();
	if (trimmed) return trimmed;
	return category.slug ? null : category.name;
}

/**
 * Whether another of the list's categories, hidden ones included, already
 * shows `name` (case and spacing aside): the form refuses it, as the item
 * sheet refuses a name already on the list.
 */
export function categoryNameTaken(
	name: string,
	categories: Pick<ListCategory, 'id' | 'name' | 'slug'>[],
	templates: Map<string, CategoryTemplate>,
	exceptId?: string
): boolean {
	const wanted = categoryNameKey(name);
	return categories.some(
		(c) => c.id !== exceptId && categoryNameKey(categoryName(c, templates)) === wanted
	);
}

/** What two category names are compared by: case and spacing aside. */
export function categoryNameKey(name: string): string {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** The sort_order a new category takes: after every row the list has, hidden ones included. */
export function nextSortOrder(categories: Pick<ListCategory, 'sort_order'>[]): number {
	return Math.max(0, ...categories.map((c) => c.sort_order)) + 1;
}

/** Non-tombstoned rows only — a tombstone means "hidden/removed from this list" (§6.7). */
export function visibleCategories(categories: ListCategory[]): ListCategory[] {
	return visibleIndex(categories).visible;
}

/** Category lookup memoized on the array identity, so `categoryOf` does not
 *  rebuild it per item. Emissions bring fresh arrays, and the WeakMap drops
 *  the old entries. */
interface VisibleIndex {
	visible: ListCategory[];
	byId: Map<string, ListCategory>;
	others: ListCategory | undefined;
}

const visibleCache = new WeakMap<ListCategory[], VisibleIndex>();

function visibleIndex(categories: ListCategory[]): VisibleIndex {
	let entry = visibleCache.get(categories);
	if (!entry) {
		const visible = categories.filter((c) => c.deleted_at === null);
		entry = {
			visible,
			byId: new Map(visible.map((c) => [c.id, c])),
			others: visible.find((c) => c.slug === OTHERS_SLUG)
		};
		visibleCache.set(categories, entry);
	}
	return entry;
}

/**
 * Aisle order (§6.7): `sort_order` ascending, then name, with Others last
 * whatever its `sort_order` [D-30], so uncategorised items never sit mid-walk.
 */
export function sortCategories(
	categories: ListCategory[],
	templates: Map<string, CategoryTemplate>
): ListCategory[] {
	const coll = collator();
	return [...categories].sort((a, b) => {
		const aOther = a.slug === OTHERS_SLUG;
		const bOther = b.slug === OTHERS_SLUG;
		if (aOther !== bOther) return aOther ? 1 : -1;
		if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
		return coll.compare(categoryName(a, templates), categoryName(b, templates));
	});
}

/** The list's Others row, if it has one (every seeded list does — §7.5). */
export function othersCategory(categories: ListCategory[]): ListCategory | undefined {
	return visibleIndex(categories).others;
}

/**
 * The category an item renders under (§6.6): its `category_key`, or Others
 * when that is null or points at a hidden or missing row.
 */
export function categoryOf(
	item: Pick<Item, 'category_key'>,
	categories: ListCategory[]
): ListCategory | undefined {
	const index = visibleIndex(categories);
	const direct = item.category_key ? index.byId.get(item.category_key) : undefined;
	return direct ?? index.others;
}

/** Templates keyed by slug, the shape `categoryName` / `sortCategories` want. */
export function templateMap(templates: CategoryTemplate[]): Map<string, CategoryTemplate> {
	return new Map(templates.map((t) => [t.slug, t]));
}

/**
 * [D-251] The current templates ([D-300]) a list has no row for, in walk order: what "add the
 * missing categories" would add. A removed (hidden) row counts as present; the
 * editor restores those itself.
 */
export function missingTemplates(
	templates: Iterable<CategoryTemplate>,
	categories: Pick<ListCategory, 'slug'>[]
): CategoryTemplate[] {
	const have = new Set(categories.map((c) => c.slug));
	return [...templates]
		.filter((t) => !t.retired && !have.has(t.slug))
		.sort((a, b) => a.sort_order - b.sort_order);
}

/** Localized swatch labels: a screen reader must not announce the raw token. */
export const COLOR_LABEL_KEYS = {
	green: 'color_green',
	amber: 'color_amber',
	sky: 'color_sky',
	red: 'color_red',
	olive: 'color_olive',
	yellow: 'color_yellow',
	violet: 'color_violet',
	orange: 'color_orange',
	pink: 'color_pink',
	cyan: 'color_cyan',
	teal: 'color_teal',
	wine: 'color_wine',
	slate: 'color_slate',
	lavender: 'color_lavender',
	brown: 'color_brown',
	blue: 'color_blue',
	steel: 'color_steel',
	lime: 'color_lime',
	indigo: 'color_indigo',
	magenta: 'color_magenta',
	gray: 'color_gray'
} satisfies Record<PaletteToken, MessageKey>;
