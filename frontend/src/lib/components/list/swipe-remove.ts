// A planning row removed by a swipe to the left (§9.1 [D-289]): a shortcut
// beside the detail sheet's trash, which stays the keyboard's and assistive
// technology's path. @use-gesture's DragGesture tracks the pointer (the axis,
// the capture, the flick, the click a drag must not become); this decides how
// far a release must go and reports where the row is, and the row paints it. Mouse and touch alike, so Playwright's mouse drives it.
import { DragGesture } from '@use-gesture/vanilla';
import type { Attachment } from 'svelte/attachments';
import { on } from 'svelte/events';
import { dur } from '#lib/state/motion.js';

/** Movement before the gesture picks an axis; vertical first is a scroll. */
export const SLOP_PX = 10;
/** Released past this share of the row's width, the row goes. */
export const COMMIT_SHARE = 0.4;
/** Its bounds: a narrow row still needs a deliberate drag, a wide one no
 *  trip across the screen. */
export const COMMIT_MIN_PX = 96;
export const COMMIT_MAX_PX = 160;
/** Snap back, or slide out before the remove. */
export const SETTLE_MS = 180;

export interface SwipeState {
	/** The row's offset in px, physical: negative is leftward. */
	offset: number;
	/** Following the finger: no transition. */
	dragging: boolean;
	/** Released now, the row would go. */
	armed: boolean;
}

export const SWIPE_AT_REST: SwipeState = { offset: 0, dragging: false, armed: false };

interface Options {
	/** Null while the row has no remove: the gesture does nothing. */
	remove: () => (() => void) | null | undefined;
	update: (state: SwipeState) => void;
}

/** How far left a release removes, for a row this wide. */
export function threshold(width: number): number {
	return Math.min(Math.max(width * COMMIT_SHARE, COMMIT_MIN_PX), COMMIT_MAX_PX);
}

export function swipeToRemove({ remove, update }: Options): Attachment<HTMLElement> {
	return (node) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let dragging = false;

		function settle(offset: number): void {
			dragging = false;
			update({ offset, dragging: false, armed: false });
		}

		const gesture = new DragGesture(
			node,
			({ first, last, active, canceled, tap, cancel, event, movement: [mx], swipe: [flick] }) => {
				// No remove on this row, or the quantity field, where a drag
				// selects its text.
				if (first && (!remove() || (event.target as Element).closest('input, textarea'))) {
					cancel();
					return;
				}
				if (canceled) {
					if (dragging) settle(0);
					return;
				}
				const width = node.offsetWidth;
				const distance = Math.max(0, -mx);
				if (active) {
					dragging = true;
					update({
						offset: -distance,
						dragging: true,
						armed: distance >= threshold(width)
					});
					return;
				}
				if (!last || tap || !dragging) return;
				const go = remove();
				// Past the threshold, or flicked left: the library's swipe, over
				// 50px at over 0.5px/ms within 250ms.
				if (event.type === 'pointercancel' || !go || !(distance >= threshold(width) || flick < 0)) {
					settle(0);
					return;
				}
				settle(-width);
				// After the slide-out; the row's slot then leaves with the item.
				timer = setTimeout(go, dur(SETTLE_MS));
			},
			{
				// A vertical first move past the slop is a scroll: the row stays.
				axis: 'x',
				axisThreshold: { mouse: SLOP_PX, touch: SLOP_PX, pen: SLOP_PX },
				// Within the slop a release is a tap, whose click opens the row;
				// after a drag the library swallows the click.
				filterTaps: true,
				tapsThreshold: SLOP_PX,
				// The keyboard's path is the sheet's trash.
				pointer: { keys: false }
			}
		);

		// iOS can still start a scroll mid-swipe despite `touch-action`. Not the
		// library's preventScroll, which delays every drag instead.
		const stopTouch = on(
			node,
			'touchmove',
			(e) => {
				if (dragging && e.cancelable) e.preventDefault();
			},
			{ passive: false }
		);

		return () => {
			clearTimeout(timer);
			gesture.destroy();
			stopTouch();
		};
	};
}
