import { describe, expect, it } from 'vitest';
import {
	createTapGuard,
	noteMoved,
	tapPoint,
	TAP_GUARD_MS,
	TAP_GUARD_RADIUS_PX
} from './tap-guard';

function guard() {
	let clock = 0;
	const accept = createTapGuard(() => clock);
	return {
		accept,
		advance: (ms: number) => {
			clock += ms;
		}
	};
}

describe('the shop double-tap guard ([D-213])', () => {
	it('refuses a second tap on the same spot while the neighbour slides in', () => {
		const g = guard();
		expect(g.accept({ x: 100, y: 200 })).toBe(true);
		g.advance(150);
		expect(g.accept({ x: 103, y: 198 })).toBe(false);
	});

	it('accepts the same spot again once the slide is over', () => {
		const g = guard();
		g.accept({ x: 100, y: 200 });
		g.advance(TAP_GUARD_MS);
		expect(g.accept({ x: 100, y: 200 })).toBe(true);
	});

	it('never slows down a quick tap on a different tile', () => {
		const g = guard();
		g.accept({ x: 100, y: 200 });
		g.advance(50);
		expect(g.accept({ x: 100 + TAP_GUARD_RADIUS_PX + 1, y: 200 })).toBe(true);
	});

	it('measures from the last ACCEPTED tap, so a refused one cannot extend the window', () => {
		const g = guard();
		g.accept({ x: 100, y: 200 });
		g.advance(TAP_GUARD_MS - 10);
		expect(g.accept({ x: 100, y: 200 })).toBe(false);
		g.advance(10);
		expect(g.accept({ x: 100, y: 200 })).toBe(true);
	});

	// A co-member's tick slides a tile under a finger on its way down: the tap
	// was aimed at what was there. (Any object stands in for the tile here.)
	it('refuses a tap on a tile that has just slid into place, whoever moved it', () => {
		const g = guard();
		const tile = {} as Element;
		noteMoved(tile, 1000);
		g.advance(1000 + TAP_GUARD_MS - 10);
		expect(g.accept({ x: 100, y: 200 }, tile)).toBe(false);
		g.advance(10);
		expect(g.accept({ x: 100, y: 200 }, tile)).toBe(true);
	});

	it('accepts a tap on a tile that stayed where it was', () => {
		const g = guard();
		g.advance(1000);
		noteMoved({} as Element, 1000);
		expect(g.accept({ x: 100, y: 200 }, {} as Element)).toBe(true);
	});

	it('lets a keyboard activation of a tile that just moved through', () => {
		const g = guard();
		const tile = {} as Element;
		noteMoved(tile, 0);
		expect(g.accept(null, tile)).toBe(true);
	});

	it('lets every keyboard activation through', () => {
		const g = guard();
		g.accept({ x: 100, y: 200 });
		expect(g.accept(null)).toBe(true);
		expect(g.accept(null)).toBe(true);
	});

	it('reads a keyboard click (detail 0) as no position', () => {
		expect(tapPoint({ detail: 0, clientX: 5, clientY: 5 })).toBeNull();
		expect(tapPoint({ detail: 1, clientX: 5, clientY: 6 })).toEqual({
			x: 5,
			y: 6
		});
	});
});
