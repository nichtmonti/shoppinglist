// The release rule of the planning row's swipe ([D-289]).
import { describe, expect, it } from 'vitest';
import { COMMIT_MAX_PX, COMMIT_MIN_PX, FLICK_PX, FLICK_SPEED, commits } from './swipe-remove.js';

describe('commits', () => {
	it('removes past 40% of the row, slowly or not', () => {
		expect(commits(160, 0, 390)).toBe(true);
		expect(commits(150, 0, 390)).toBe(false);
	});

	it('takes no more than the cap on a wide row', () => {
		expect(commits(COMMIT_MAX_PX - 1, 0, 1280)).toBe(false);
		expect(commits(COMMIT_MAX_PX, 0, 1280)).toBe(true);
	});

	it('never takes less than the floor on a narrow row', () => {
		expect(commits(COMMIT_MIN_PX - 1, 0, 200)).toBe(false);
		expect(commits(COMMIT_MIN_PX, 0, 200)).toBe(true);
	});

	it('removes on a flick, but not on a fast twitch', () => {
		expect(commits(FLICK_PX, FLICK_SPEED, 390)).toBe(true);
		expect(commits(FLICK_PX - 1, 2, 390)).toBe(false);
		expect(commits(100, FLICK_SPEED - 0.1, 390)).toBe(false);
	});
});
