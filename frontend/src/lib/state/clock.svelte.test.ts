// Now (§6.10): a next change further out than setTimeout can wait (2^31-1 ms,
// about 24.8 days) must not arm a timer the browser fires at once, which the
// effect would re-arm in a loop. That happens with a checked_at stamped weeks
// ahead of a phone whose date is wrong.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Now } from './clock.svelte';

const MAX_TIMEOUT = 2 ** 31 - 1;

afterEach(() => vi.restoreAllMocks());

describe('Now', () => {
	it('never asks setTimeout for more than it can wait', () => {
		const delays: number[] = [];
		const real = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
			delays.push(ms ?? 0);
			return real(() => {}, 0);
		}) as typeof setTimeout);

		const stop = $effect.root(() => {
			new Now((now) => now + 60 * 24 * 3600 * 1000); // 60 days ahead
		});
		flushSync();
		stop();

		expect(delays.length).toBeGreaterThan(0);
		expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMEOUT);
	});
});
