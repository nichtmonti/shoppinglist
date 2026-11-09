// Test-only timer instrumentation for the one class of dependency a test
// cannot otherwise observe: a callback whose ABSENCE is the assertion (the
// sync loop must not re-arm a retry after stop()).
//
// trackTimers() wraps globalThis.setTimeout/clearTimeout TRANSPARENTLY —
// same handles, same timing, unwatched delays untouched — and counts the
// scheduled-but-unfired timers whose delay matches. A test then waits for
// `pending()` to reach 0 (the dependent event: the timer fired, or was
// cleared) instead of sleeping past the longest possible delay. A pending
// count that never drains fails the wait loudly, at the test that armed it.

export interface TrackedTimers {
	/** Scheduled-but-unfired timers whose delay matched the predicate. */
	pending(): number;
	/** Restore the pristine timer globals and forget tracked handles. */
	dispose(): void;
}

export function trackTimers(match: (delay: number) => boolean): TrackedTimers {
	// The pristine references dispose() restores — the raw globals, NOT the
	// bound copies below: installing a `.bind()` copy on dispose would stack
	// a "bound bound …" layer per wrap/restore cycle and change
	// globalThis.setTimeout's identity across afterAll-cleaned test files.
	const pristineSet = globalThis.setTimeout;
	const pristineClear = globalThis.clearTimeout;
	// Bound copies for the tracker's own calls, so `this` stays right no
	// matter how the wrapper ends up invoked.
	const originalSet = pristineSet.bind(globalThis);
	const originalClear = pristineClear.bind(globalThis);
	const active = new Set<ReturnType<typeof setTimeout>>();

	// TimerHandler can be a string in the DOM spec; nothing in this repo or
	// its dependencies schedules strings — pass those through untracked.
	const wrappedSet = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		const delay = typeof timeout === 'number' ? timeout : 0;
		if (typeof handler !== 'function' || !match(delay)) {
			return originalSet(handler, timeout, ...args);
		}
		// Trampoline: remove the handle from the tracked set when it fires,
		// then invoke the real handler with its original arguments.
		const timer = originalSet(
			(...fired: unknown[]) => {
				active.delete(timer);
				(handler as (...a: unknown[]) => void)(...fired);
			},
			timeout,
			...args
		);
		active.add(timer);
		return timer;
	}) as unknown as typeof globalThis.setTimeout;

	const wrappedClear = ((handle?: unknown) => {
		active.delete(handle as ReturnType<typeof setTimeout>);
		originalClear(handle as Parameters<typeof clearTimeout>[0]);
	}) as unknown as typeof globalThis.clearTimeout;

	globalThis.setTimeout = wrappedSet;
	globalThis.clearTimeout = wrappedClear;

	return {
		pending: () => active.size,
		dispose: () => {
			globalThis.setTimeout = pristineSet;
			globalThis.clearTimeout = pristineClear;
			active.clear();
		}
	};
}
