// Direct unit cover for the timer tracker the client setup and loop.test assert
// through: its own contract — matching, clearing, passthrough, restore — is
// otherwise exercised only incidentally, by callers with their own agendas.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTimers } from './timers';

// A delay no tracker below matches, so the settle waits themselves stay
// untracked and cannot pollute the pending() counts under assertion.
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

let timers: ReturnType<typeof trackTimers> | undefined;
afterEach(() => {
	timers?.dispose();
	timers = undefined;
});

describe('trackTimers', () => {
	it('counts a matching timer until it fires, forwarding extra args', async () => {
		timers = trackTimers((d) => d === 25);
		const fired = vi.fn();
		setTimeout(fired, 25, 'a', 'b');
		expect(timers.pending()).toBe(1);
		await settle(60);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveBeenCalledWith('a', 'b');
	});

	it('leaves non-matching delays untracked but running', async () => {
		timers = trackTimers((d) => d === 25);
		const fired = vi.fn();
		setTimeout(fired, 5);
		expect(timers.pending()).toBe(0);
		await settle(30);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('treats an absent delay as 0 for the predicate', async () => {
		timers = trackTimers((d) => d === 0);
		const fired = vi.fn();
		setTimeout(fired);
		expect(timers.pending()).toBe(1);
		await settle(30);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('clearTimeout removes the tracked handle', async () => {
		timers = trackTimers((d) => d === 25);
		const fired = vi.fn();
		const handle = setTimeout(fired, 25);
		expect(timers.pending()).toBe(1);
		clearTimeout(handle);
		expect(timers.pending()).toBe(0);
		await settle(60);
		expect(fired).not.toHaveBeenCalled();
	});

	it('passes string handlers through to the original instead of tracking them', () => {
		timers = trackTimers(() => true);
		// The DOM TimerHandler union admits strings; node's real setTimeout
		// throws on one. The wrapper must delegate that verdict — a trampoline
		// around a string would turn it into a fire-time TypeError instead. The
		// string handler IS the subject here, so the rule yields to the test
		// rather than the test being rewritten around it.
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		expect(() => setTimeout('1+1', 0)).toThrow();
		expect(timers.pending()).toBe(0);
	});

	// Functional contract only: dispose reinstalls a fresh bound copy of the
	// pre-wrap globals rather than the originals, so cross-cycle IDENTITY is
	// not preserved (each wrap/dispose adds a .bind layer) — reported, not
	// pinned here. What matters to callers is that scheduling works again and
	// nothing stays tracked.
	it('dispose forgets tracked handles and leaves scheduling untracked', async () => {
		timers = trackTimers((d) => d === 25);
		setTimeout(vi.fn(), 25);
		expect(timers.pending()).toBe(1);
		timers.dispose();
		expect(timers.pending()).toBe(0);
		const fired = vi.fn();
		const handle = setTimeout(fired, 25);
		expect(timers.pending()).toBe(0);
		await settle(60);
		expect(fired).toHaveBeenCalledTimes(1);
		clearTimeout(handle);
	});
});
