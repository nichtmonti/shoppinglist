// The item sheet's edit (§9.1 "fuller edits"): which fields a set of drafts
// actually changes, so a commit sends only those.
import type { Item, ListCategory } from './db';
import { categoryOf } from './categories';
import { displayName } from './item-name';

export interface ItemDrafts {
	name: string;
	quantity: string;
	note: string;
	/** The chosen category row's id; '' for none. */
	category: string;
}

export type ItemEditPatch = Partial<Pick<Item, 'name' | 'quantity' | 'note' | 'category_key'>>;

/** The drafts a sheet opens with for `item`. The name is the one the viewer
 *  SEES, and itemEditPatch compares against the same, so an untouched field
 *  never sends a rename ([D-21]). */
export function itemDrafts(item: Item, categories: ListCategory[]): ItemDrafts {
	return {
		name: displayName(item),
		quantity: item.quantity,
		note: item.note ?? '',
		category: categoryOf(item, categories)?.id ?? ''
	};
}

/**
 * The drafts diffed against `item`: only what changed, so several fields
 * moved together commit as one edit. Text is trimmed; an emptied name keeps
 * the row's current name, and an emptied note clears it.
 *
 * Only a field the drafts changed since `from`, the drafts the sheet opened
 * with: a co-member's edit arriving while the sheet is open moves the row, not
 * the drafts, and sending the stale value back would undo it unnoticed, since
 * the op's base is already theirs (§8.4).
 */
export function itemEditPatch(
	item: Item,
	drafts: ItemDrafts,
	categories: ListCategory[],
	from: ItemDrafts = itemDrafts(item, categories)
): ItemEditPatch {
	const patch: ItemEditPatch = {};
	const name = drafts.name.trim();
	if (name && name !== from.name.trim() && name !== displayName(item)) patch.name = name;
	const quantity = drafts.quantity.trim();
	if (quantity !== from.quantity.trim() && quantity !== item.quantity) patch.quantity = quantity;
	const note = drafts.note.trim() || null;
	if (note !== (from.note.trim() || null) && note !== item.note) patch.note = note;
	if (
		drafts.category !== from.category &&
		drafts.category !== (categoryOf(item, categories)?.id ?? '')
	) {
		patch.category_key = drafts.category;
	}
	return patch;
}
