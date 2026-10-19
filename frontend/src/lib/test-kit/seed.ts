// The real seed (backend/seed/), as every install mirrors it into Dexie and
// every new list copies its aisles (§7.5). Imported rather than read off disk,
// as field-contract.ts imports its JSON, so a test names no path.
import items from '../../../../backend/seed/items.json';
import categories from '../../../../backend/seed/categories.json';
import type { CategoryTemplate, ItemDictionary, ListCategory } from '#lib/db.js';
import { makeCategory } from './db';

export const seedDictionary = items as ItemDictionary[];

/** The category templates, `retired` filled in as the server serves it. */
export const seedTemplates: CategoryTemplate[] = (
	categories as (Omit<CategoryTemplate, 'retired'> & { retired?: boolean })[]
).map((c) => ({ ...c, retired: c.retired === true }));

/** A list whose categories are the seed copy, with ids `cat_<slug>`. */
export function seededCategories(list: string): ListCategory[] {
	return seedTemplates.map((t) =>
		makeCategory({ list, id: `cat_${t.slug}`, slug: t.slug, name: null, sort_order: t.sort_order })
	);
}
