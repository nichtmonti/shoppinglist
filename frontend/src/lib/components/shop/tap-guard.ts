// The shop grid's double-tap guard ([D-213]): a check-off slides the
// neighbour into the vacated slot, where a second tap would check off an item
// never aimed at. A tap is refused when it is both that soon and that close
// to the last accepted one, or when it lands on a tile that slid into place
// that recently, whoever's check-off moved it: a co-member's tick slides a
// tile under a finger on its way down. A keyboard activation is never guarded.

import { ROW_FLIP_MS } from '#lib/state/motion.js';

/** Long enough to cover the slide and a human double tap's second press. */
export const TAP_GUARD_MS = ROW_FLIP_MS + 160;
/** A finger's jitter, not a tile's width: a neighbour is always farther. */
export const TAP_GUARD_RADIUS_PX = 24;

// When each tile last slid to a new place, noted by its flip.
const movedAt = new WeakMap<Element, number>();

/** Notes that `tile` slid to a new place (the grid's animate calls this). */
export function noteMoved(tile: Element, at: number = performance.now()): void {
	movedAt.set(tile, at);
}

export interface TapPoint {
	x: number;
	y: number;
}

/**
 * Returns `accept(point, tile)`: true when the tap should check something
 * off. `point` is null for a keyboard activation, which always passes; `tile`
 * is the tapped tile, refused while it has just slid into place.
 */
export function createTapGuard(now: () => number = () => performance.now()) {
	let last: (TapPoint & { at: number }) | null = null;
	return function accept(point: TapPoint | null, tile?: Element | null): boolean {
		if (!point) return true;
		const at = now();
		const moved = tile ? movedAt.get(tile) : undefined;
		if (moved !== undefined && at - moved < TAP_GUARD_MS) return false;
		if (
			last &&
			at - last.at < TAP_GUARD_MS &&
			Math.hypot(point.x - last.x, point.y - last.y) < TAP_GUARD_RADIUS_PX
		) {
			return false;
		}
		last = { ...point, at };
		return true;
	};
}

/** The tap position of a click, or null when a keyboard produced it. */
export function tapPoint(
	event: Pick<MouseEvent, 'detail' | 'clientX' | 'clientY'>
): TapPoint | null {
	return event.detail === 0 ? null : { x: event.clientX, y: event.clientY };
}
