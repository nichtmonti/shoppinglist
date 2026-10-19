// Direct unit cover for untilLoaded(): every caller goes through the cold
// factory-store path, so the deadline rejection, the all-stores semantics,
// the synchronous warm-store emission and the unsubscribe contract are
// pinned only here.
import { describe, expect, it, vi } from 'vitest';
import { readable, type Readable } from 'svelte/store';
import type { LiveStore } from '#lib/state/live.js';
import { untilLoaded } from './db';

function storeWith(loaded: Readable<boolean>): LiveStore<unknown> {
	return { subscribe: readable(null).subscribe, loaded, read: async () => null };
}

describe('untilLoaded', () => {
	it('resolves when the loaded flag flips on the first emission', async () => {
		const loaded = readable(false, (set) => {
			const t = setTimeout(() => set(true), 10);
			return () => clearTimeout(t);
		});
		await expect(untilLoaded(storeWith(loaded))).resolves.toBeUndefined();
	});

	// A store whose loaded flag is already true runs the subscriber
	// SYNCHRONOUSLY inside subscribe() — until the fix this hit the
	// `unsub` temporal dead zone and threw ReferenceError before the
	// assignment completed. The warm-store path stays pinned here: the
	// module-level singletons in state/data.ts would hit it even though
	// every current caller passes a cold factory store.
	it('resolves an already-loaded store without waiting on the deadline', async () => {
		await expect(untilLoaded(storeWith(readable(true)))).resolves.toBeUndefined();
	});

	it('waits for every store, not just the first to flip', async () => {
		let flipA!: () => void;
		let flipB!: () => void;
		const a = readable(false, (set) => {
			flipA = () => set(true);
			return () => undefined;
		});
		const b = readable(false, (set) => {
			flipB = () => set(true);
			return () => undefined;
		});
		const done = untilLoaded(storeWith(a), storeWith(b));
		const probe = vi.fn();
		// `void`, not `await`: the probe OBSERVES when `done` settles, and awaiting
		// it here would defeat the "not yet called" assertion three lines down. The
		// promise is still awaited — by the `await done` below, which is also what
		// surfaces a rejection, so nothing is actually swallowed.
		void done.then(probe);
		flipA();
		await new Promise((r) => setTimeout(r, 5));
		expect(probe).not.toHaveBeenCalled();
		flipB();
		await done;
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes from loaded once resolved', async () => {
		let stopped = false;
		const loaded = readable(false, (set) => {
			const t = setTimeout(() => set(true), 0);
			return () => {
				stopped = true;
				clearTimeout(t);
			};
		});
		await untilLoaded(storeWith(loaded));
		expect(stopped).toBe(true);
	});

	it('rejects at the 5s deadline when a store never emits, and unsubscribes', async () => {
		vi.useFakeTimers();
		try {
			let stopped = false;
			const loaded = readable(false, () => () => {
				stopped = true;
			});
			const p = untilLoaded(storeWith(loaded));
			// Handlers attached before the clock crosses the deadline, or the
			// rejection is unhandled the moment it fires.
			const rejected = expect(p).rejects.toThrow('live store never emitted its first value');
			let settled = false;
			p.then(
				() => (settled = true),
				() => (settled = true)
			);
			vi.advanceTimersByTime(4999);
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			await rejected;
			expect(settled).toBe(true);
			expect(stopped).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
