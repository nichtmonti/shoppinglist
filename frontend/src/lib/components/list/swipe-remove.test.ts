// How far the planning row's swipe must go ([D-289]); the flick is the
// library's.
import { describe, expect, it } from 'vitest';
import { COMMIT_MAX_PX, COMMIT_MIN_PX, threshold } from './swipe-remove.js';

describe('threshold', () => {
	it('is 40% of the row', () => {
		expect(threshold(390)).toBe(156);
	});

	it('takes no more than the cap on a wide row', () => {
		expect(threshold(1280)).toBe(COMMIT_MAX_PX);
	});

	it('never takes less than the floor on a narrow row', () => {
		expect(threshold(200)).toBe(COMMIT_MIN_PX);
	});
});
