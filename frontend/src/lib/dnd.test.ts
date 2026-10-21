// What these pin: a drag always has a gap in it.
//
// svelte-dnd-action swaps the grabbed item for a SHADOW item — same payload,
// `isDndShadowItem: true`, a placeholder id — and that shadow is the hole the
// card drops into. A mirror of the zone's items down to bare ids would drop the
// marker (so the library could not find the shadow to hide it), and filtering
// the placeholder id away would render no row for it at all — the list would
// close up under your finger. See #lib/dnd.
import { describe, it, expect } from 'vitest';
import { SHADOW_ITEM_MARKER_PROPERTY_NAME, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
import { dndItemsOf, dndMirror, dndRows, type DndItem } from './dnd';

type Row = { id: string; name: string };

const [zucker, aepfel, banane]: Row[] = [
	{ id: 'a', name: 'Zucker' },
	{ id: 'b', name: 'Äpfel' },
	{ id: 'c', name: 'Banane' }
];

/** What the library dispatches on `consider` once 'b' has been picked up: its
 *  shadow is a copy of 'b' under the placeholder id. */
function midDrag(): DndItem<Row>[] {
	return [
		{ id: 'a', row: zucker },
		{ id: SHADOW_PLACEHOLDER_ITEM_ID, row: aepfel, [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true },
		{ id: 'c', row: banane }
	];
}

describe('dndItemsOf', () => {
	it('builds the zone items array from domain rows', () => {
		expect(dndItemsOf([zucker, aepfel], (r) => r.id)).toEqual([
			{ id: 'a', row: zucker },
			{ id: 'b', row: aepfel }
		]);
	});
});

describe('dndMirror', () => {
	it('keeps the shadow marker, which is how the library finds the gap to hide', () => {
		const mirrored = dndMirror(midDrag());
		expect(mirrored.findIndex((i) => i[SHADOW_ITEM_MARKER_PROPERTY_NAME])).toBe(1);
	});

	it('copies rather than aliasing the event payload', () => {
		const items = midDrag();
		expect(dndMirror(items)[0]).not.toBe(items[0]);
		expect(dndMirror(items)).toEqual(items);
	});
});

describe('dndRows', () => {
	it('renders the dragged row in the shadow slot', () => {
		expect(dndRows(midDrag()).map((r) => r.row.name)).toEqual(['Zucker', 'Äpfel', 'Banane']);
	});

	it('keys the shadow slot by the placeholder id, not the row id', () => {
		// A new key is what makes Svelte REMOVE the original element from the
		// zone, and the library waits on that removal before it starts hit-testing
		// the drag. Re-using 'b' as the key leaves the node in place and the drag
		// never responds.
		expect(dndRows(midDrag()).map((r) => r.key)).toEqual(['a', SHADOW_PLACEHOLDER_ITEM_ID, 'c']);
	});
});
