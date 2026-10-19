// Rendering a svelte-dnd-action zone whose items are not the domain objects
// (§9.3, §6.7, through DndList in components/common/dnd-list.svelte.ts). The zone holds ids and
// rows are looked up separately, because a Membership is keyed by `list`, a
// ListCategory by `id`, and the library's id-key override is global.
//
// The trap: during a drag the library swaps the grabbed item for a SHADOW item
// (its marker plus a placeholder id) and hides it, which is the gap the drop
// lands in. A mirror of bare ids loses the marker, and one that filters
// unresolvable ids loses the shadow; either leaves a drag with no gap. So mirror
// whole items (`dndMirror`) and resolve the shadow to the dragged row
// (`dndRows`).
import { setAriaStrings, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action';
import { t } from '#lib/i18n/index.js';

/** One entry of a dndzone's `items` array: an id, plus the library's marker. */
export interface DndItem {
	id: string;
	[SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
}

/** A dndzone `items` array built from domain ids. */
export function dndItemsOf(ids: readonly string[]): DndItem[] {
	return ids.map((id) => ({ id }));
}

/**
 * Plain copies of a dnd items array, marker and all. Copies, because the
 * library keeps a reference to the array it is given and must never hold the
 * reactive proxy.
 */
export function dndMirror(items: readonly DndItem[]): DndItem[] {
	return items.map((item) => ({ ...item }));
}

/**
 * Resolve a mirror back to renderable rows. `dragged` stands in for the shadow
 * item, so the gap has the real row's height.
 *
 * `key` is the dnd id, not the row's id: the shadow's placeholder id must key a
 * NEW element so Svelte removes the original, which the library waits for
 * before it hit-tests the drag; reusing the node leaves the drag inert.
 */
export function dndRows<T>(
	items: readonly DndItem[],
	resolve: (id: string) => T | undefined,
	dragged: T | undefined
): { key: string; row: T }[] {
	const out: { key: string; row: T }[] = [];
	for (const item of items) {
		const row = item[SHADOW_ITEM_MARKER_PROPERTY_NAME] ? dragged : resolve(item.id);
		if (row !== undefined) out.push({ key: item.id, row });
	}
	return out;
}

/**
 * Screen-reader announcements for the drag lifecycle, in the active locale.
 * One definition for both surfaces, because setAriaStrings sets a module-global
 * table. Call from a `$effect`, so a language switch re-applies them.
 */
export function applyDndAriaStrings(): void {
	setAriaStrings({
		dragStarted: ({ itemLabel, zoneLabel }) =>
			t('categories_dnd_start', { item: itemLabel, zone: zoneLabel }),
		movedToPosition: ({ itemLabel, zoneLabel, position }) =>
			t('categories_dnd_moved', { item: itemLabel, zone: zoneLabel, position }),
		movedToZoneEnd: ({ itemLabel, zoneLabel }) =>
			t('categories_dnd_moved_end', { item: itemLabel, zone: zoneLabel }),
		movedToZoneStart: ({ itemLabel, zoneLabel }) =>
			t('categories_dnd_moved_start', { item: itemLabel, zone: zoneLabel }),
		dropped: ({ itemLabel }) => t('categories_dnd_cancel', { item: itemLabel }),
		zoneActiveInstruction: t('categories_dnd_instruction'),
		zoneDragDisabledInstruction: t('categories_dnd_disabled')
	});
}
