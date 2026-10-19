// The state behind ArrangeList, the reorder surface of §9.3 and §6.7. Construct
// it during component init: it registers the drag announcements as an effect.
import type { DndEvent } from 'svelte-dnd-action';
import { dur, DND_FLIP_MS } from '#lib/state/motion.js';
import { applyDndAriaStrings, dndItemsOf, dndMirror, dndRows, type DndItem } from '#lib/dnd.js';

export class DndList<T> {
	#source: () => T[];
	#idOf: (row: T) => string;
	#onreorder: (ids: string[]) => void;

	/** The row being carried; the shadow item renders as it. */
	draggingId = $state<string | null>(null);

	/** The zone's `items`: re-seeded from the source order whenever it changes,
	 *  overwritten by the handlers in between. Whole dnd items, see #lib/dnd. */
	items: DndItem[] = $derived(dndItemsOf(this.#ids()));

	/** The rows to render, keyed by dnd id; a row removed mid-drag is dropped. */
	rows: { key: string; row: T }[] = $derived(
		dndRows(this.items, (id) => this.#find(id), this.#find(this.draggingId))
	);

	/**
	 * @param source the rows in their current order — the source of truth.
	 * @param onreorder called with the new id order when a drop changed it.
	 */
	constructor(source: () => T[], idOf: (row: T) => string, onreorder: (ids: string[]) => void) {
		this.#source = source;
		this.#idOf = idOf;
		this.#onreorder = onreorder;
		$effect(() => {
			applyDndAriaStrings();
		});
	}

	#ids(): string[] {
		return this.#source().map(this.#idOf);
	}

	#find(id: string | null): T | undefined {
		return id === null ? undefined : this.#source().find((row) => this.#idOf(row) === id);
	}

	consider = (e: CustomEvent<DndEvent<DndItem>>): void => {
		this.draggingId = e.detail.info?.id ?? this.draggingId;
		this.items = dndMirror(e.detail.items);
	};

	/**
	 * One step up (-1) or down (+1), the single-pointer path beside the drag
	 * (WCAG 2.5.7, [D-237]). The mirror moves at once, so the focused button is
	 * in its new place before the store answers. Returns the new 1-based
	 * position, or null at that end.
	 */
	move(id: string, delta: -1 | 1): number | null {
		const ids = this.items.map((item) => item.id);
		const from = ids.indexOf(id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= ids.length) return null;
		[ids[from], ids[to]] = [ids[to], ids[from]];
		this.items = dndItemsOf(ids);
		this.#onreorder(ids);
		return to + 1;
	}

	finalize = (e: CustomEvent<DndEvent<DndItem>>): void => {
		const newOrder = e.detail.items.map((item) => item.id);
		this.items = dndItemsOf(newOrder);
		this.draggingId = null;
		if (newOrder.join() !== this.#ids().join()) this.#onreorder(newOrder);
	};

	/** The zone options, plus the caller's own. One flip duration for zone and
	 *  rows, through dur() so reduced motion drops both to 0 together; no
	 *  drop-target outline, since there is one zone. No touch hold ([D-90]): a
	 *  drag starts only on a row's handle. */
	zoneOptions<E extends object>(extra: E) {
		return {
			items: this.items,
			flipDurationMs: dur(DND_FLIP_MS),
			dropTargetStyle: {},
			...extra
		};
	}
}
