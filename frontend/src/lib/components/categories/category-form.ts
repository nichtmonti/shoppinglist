// What the category editor's form (CategoryFormSheet) is open on, and what its
// Save writes.
import { editedCategoryName } from '#lib/categories.js';
import type { ListCategory } from '#lib/db.js';

// A new category, or an existing one by id — resolved against the live rows,
// so a co-member's edit to the open category is what the form saves over.
export type CategoryFormTarget = { kind: 'add' } | { kind: 'edit'; id: string };

/** The form's fields as typed or picked. */
export interface CategoryDrafts {
	name: string;
	icon: string;
	color: string;
}

/**
 * The fields an edit of `category` writes: only what the drafts changed since
 * the form `opened`, so a co-member's change arriving meanwhile is not written
 * back over (§8.4). A `name` of null resets a seeded row to its template's.
 */
export function categoryEditFields(
	drafts: CategoryDrafts,
	opened: CategoryDrafts,
	category: Pick<ListCategory, 'name' | 'slug'>
): Partial<Pick<ListCategory, 'name' | 'icon' | 'color'>> {
	const fields: Partial<Pick<ListCategory, 'name' | 'icon' | 'color'>> = {};
	if (drafts.name.trim() !== opened.name.trim()) {
		fields.name = editedCategoryName(drafts.name, category);
	}
	if (drafts.icon !== opened.icon) fields.icon = drafts.icon;
	if (drafts.color !== opened.color) fields.color = drafts.color;
	return fields;
}
