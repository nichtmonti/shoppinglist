// Web Locks leader election for the shoppinglist sync engine (§8.7).
// Ensures exactly one sync loop runs across tabs sharing the same IndexedDB.
import { reportUncaught } from '#lib/client-errors.js';

// A minimal Web Locks API surface (only what we use).
export interface LocksAPI {
	request(name: string, callback: () => Promise<void>): Promise<void>;
}

function defaultLocks(): LocksAPI | undefined {
	const nav = globalThis.navigator as { locks?: LocksAPI } | undefined;
	return nav?.locks;
}

export interface LeadershipOptions {
	locks?: LocksAPI;
	/**
	 * Tear down the leader's work, AWAITED WHILE THE LOCK IS STILL HELD.
	 *
	 * Releasing is not merely "stop starting things": a drain or cycle already
	 * in flight has to finish before another tab acquires the lock, or two tabs
	 * settle the same outbox at once — the interleaving leadership exists to
	 * prevent, and the one the settle/retry paths ([D-40], [D-108]) are least
	 * able to absorb. A rejection here is swallowed: Web Locks frees the lock
	 * when the callback settles either way, but the request's promise, which
	 * nothing awaits, would reject with it unhandled.
	 */
	onRelease?: () => Promise<void> | void;
}

// Acquire the "sync-leader" lock and run `loop` while holding it. Returns a cancel function:
// calling it releases the lock (leadership hands over to another tab). If the Web Locks API is
// unavailable, `loop` runs once ungated (for non-browser/test environments) and the cancel is a no-op.
export function requestLeadership(loop: () => void, opts: LeadershipOptions = {}): () => void {
	const locks = opts.locks ?? defaultLocks();
	if (!locks) {
		try {
			loop();
		} catch (error) {
			// Leadership errors must not crash the app, but are reported.
			reportUncaught(error, 'sync leader');
		}
		// No Web Locks: this context IS the leader for its own lifetime, so the
		// cancel still has to run the teardown — otherwise a stopped loop in a
		// test or SSR context keeps its subscription.
		return () => void Promise.resolve(opts.onRelease?.()).catch(() => {});
	}
	let cancelled = false;
	let release: (() => void) | null = null;
	// Fire-and-forget: requestLeadership returns synchronously; the lock is held until the
	// callback's promise resolves.
	void locks.request('sync-leader', async () => {
		if (cancelled) return; // cancelled before acquired
		await new Promise<void>((resolve) => {
			release = resolve;
			try {
				loop();
			} catch (error) {
				reportUncaught(error, 'sync leader');
			}
		});
		// STILL HOLDING THE LOCK here — see onRelease. The next tab waiting on
		// 'sync-leader' does not acquire it until this callback's promise settles.
		try {
			await opts.onRelease?.();
		} catch {
			/* the lock is freed either way; this keeps the rejection handled */
		}
	});
	return () => {
		cancelled = true;
		if (release) release();
	};
}
