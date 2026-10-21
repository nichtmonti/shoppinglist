// Rendering a svelte-dnd-action zone over domain rows (§9.3, §6.7, through
// DndList in components/common/dnd-list.svelte.ts). Each zone item is
// `{ id, row }`: the library's id key is global, and a Membership is keyed by
// `list`, a ListCategory by `id`.
//
// The trap: during a drag the library swaps the grabbed item for a SHADOW item
// (a copy of it, with its marker and a placeholder id) and hides it, which is
// the gap the drop lands in. A mirror that loses the marker, or filters the
// placeholder id, leaves a drag with no gap. So mirror whole items
// (`dndMirror`); the shadow carries the dragged row, so the gap has its height.
import { setAriaStrings, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action';
import { t } from '#lib/i18n/index.js';

/** One entry of a dndzone's `items` array: a row under its id, plus the
 *  library's marker. */
export interface DndItem<T> {
	id: string;
	row: T;
	[SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
}

/** A dndzone `items` array over domain rows. */
export function dndItemsOf<T>(rows: readonly T[], idOf: (row: T) => string): DndItem<T>[] {
	return rows.map((row) => ({ id: idOf(row), row }));
}

/**
 * Plain copies of a dnd items array, marker and all. Copies, because the
 * library keeps a reference to the array it is given and must never hold the
 * reactive proxy.
 */
export function dndMirror<T>(items: readonly DndItem<T>[]): DndItem<T>[] {
	return items.map((item) => ({ ...item }));
}

/**
 * The rows to render. `key` is the dnd id, not the row's id: the shadow's
 * placeholder id must key a NEW element so Svelte removes the original, which
 * the library waits for before it hit-tests the drag; reusing the node leaves
 * the drag inert.
 */
export function dndRows<T>(items: readonly DndItem<T>[]): { key: string; row: T }[] {
	return items.map(({ id, row }) => ({ key: id, row }));
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
