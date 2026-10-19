// A planning row removed by a swipe toward its start (§9.1 [D-289]): a
// shortcut beside the detail sheet's trash, which stays the keyboard's and
// assistive technology's path. The attachment owns the gesture and reports
// where the row is; the row paints it. Mouse and touch alike, so Playwright's
// mouse drives it.
import type { Attachment } from 'svelte/attachments';
import { dur } from '#lib/state/motion.js';

/** Movement before the gesture picks an axis; vertical first is a scroll. */
export const SLOP_PX = 10;
/** Released past this share of the row's width, the row goes. */
export const COMMIT_SHARE = 0.4;
/** Its bounds: a narrow row still needs a deliberate drag, a wide one no
 *  trip across the screen. */
export const COMMIT_MIN_PX = 96;
export const COMMIT_MAX_PX = 160;
/** A flick: at least this far, and this fast (px/ms) over its last moments. */
export const FLICK_PX = 48;
export const FLICK_SPEED = 0.5;
export const FLICK_WINDOW_MS = 100;
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

/** How far toward the start a release removes, for a row this wide. */
export function threshold(width: number): number {
	return Math.min(Math.max(width * COMMIT_SHARE, COMMIT_MIN_PX), COMMIT_MAX_PX);
}

/** Whether a release at `distance` (toward the start) at `speed` removes. */
export function commits(distance: number, speed: number, width: number): boolean {
	if (distance >= threshold(width)) return true;
	return distance >= FLICK_PX && speed >= FLICK_SPEED;
}

export function swipeToRemove({ remove, update }: Options): Attachment<HTMLElement> {
	return (node) => {
		let start: { x: number; y: number; id: number } | null = null;
		let locked = false;
		// The recent moves, for the release speed.
		let moves: { x: number; t: number }[] = [];
		// The click that ends a swipe must not open the sheet.
		let swallowClick = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		// Toward the start: leftward, or rightward in a right-to-left row.
		const sign = () => (getComputedStyle(node).direction === 'rtl' ? 1 : -1);
		const toward = (x: number) => (x - (start?.x ?? x)) * sign();
		const width = () => node.offsetWidth;

		function settle(offset: number): void {
			update({ offset, dragging: false, armed: false });
		}

		function down(e: PointerEvent): void {
			swallowClick = false;
			if (!remove() || !e.isPrimary || e.button !== 0) return;
			// The quantity field: a drag there selects its text.
			if ((e.target as Element).closest('input, textarea')) return;
			start = { x: e.clientX, y: e.clientY, id: e.pointerId };
			locked = false;
			moves = [{ x: e.clientX, t: e.timeStamp }];
		}

		function move(e: PointerEvent): void {
			if (!start || e.pointerId !== start.id) return;
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			if (!locked) {
				if (Math.abs(dy) > SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
					start = null;
					return;
				}
				if (Math.abs(dx) <= SLOP_PX) return;
				locked = true;
				try {
					node.setPointerCapture(e.pointerId);
				} catch {
					// Already released; the moves still arrive on the row.
				}
			}
			moves.push({ x: e.clientX, t: e.timeStamp });
			moves = moves.filter((m) => e.timeStamp - m.t <= FLICK_WINDOW_MS);
			const distance = Math.max(0, toward(e.clientX));
			update({ offset: distance * sign(), dragging: true, armed: distance >= threshold(width()) });
		}

		function up(e: PointerEvent): void {
			if (!start || e.pointerId !== start.id) return;
			const wasLocked = locked;
			const distance = Math.max(0, toward(e.clientX));
			const first = moves[0];
			const dt = e.timeStamp - (first?.t ?? e.timeStamp);
			const speed = first && dt > 0 ? ((e.clientX - first.x) * sign()) / dt : 0;
			start = null;
			locked = false;
			if (!wasLocked) return;
			swallowClick = true;
			const go = remove();
			if (!go || !commits(distance, speed, width())) {
				settle(0);
				return;
			}
			settle(sign() * width());
			// After the slide-out; the row's slot then leaves with the item.
			timer = setTimeout(go, dur(SETTLE_MS));
		}

		function cancel(e: PointerEvent): void {
			if (!start || e.pointerId !== start.id) return;
			start = null;
			if (locked) settle(0);
			locked = false;
		}

		function click(e: MouseEvent): void {
			if (!swallowClick) return;
			swallowClick = false;
			e.preventDefault();
			e.stopPropagation();
		}

		// iOS can still start a scroll mid-swipe despite `touch-action`.
		function touchmove(e: TouchEvent): void {
			if (locked && e.cancelable) e.preventDefault();
		}

		node.addEventListener('pointerdown', down);
		node.addEventListener('pointermove', move);
		node.addEventListener('pointerup', up);
		node.addEventListener('pointercancel', cancel);
		node.addEventListener('click', click, true);
		node.addEventListener('touchmove', touchmove, { passive: false });
		return () => {
			clearTimeout(timer);
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('click', click, true);
			node.removeEventListener('touchmove', touchmove);
		};
	};
}
