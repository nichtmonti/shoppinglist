// When a cycle runs (§8.5, §8.7): on becoming leader, on an idle tick, on
// focus, online and visibility, after a failure; plus a debounced drain on
// every local mutation. What a cycle does is cycle.ts.
import { db } from '#lib/db.js';
import { drainOutbox, type DrainOptions } from '#lib/sync/push.js';
import { requestLeadership } from '#lib/sync/leader.js';
import { trackVisibility, type VisibilityTracker } from '#lib/sync/visibility.js';
import { NO_RESULT, recordEnd, recordExchange, recordStart } from '#lib/sync/health.js';
import { liveQuery } from 'dexie';
import {
	afterCycles,
	cyclesSettled,
	runSyncCycle,
	type CycleDeps,
	type CycleResult
} from './cycle';

export interface SyncLoopOptions extends CycleDeps {
	cycleMs?: number; // idle tick interval, default 60000
	// After each completed cycle (the roster refresh hangs off it, §7.4).
	onCycle?: (result: CycleResult) => void;
	// Fixed delay before a failed cycle or undelivered push re-runs, no backoff
	// ([D-164], [D-139]). Default 5s.
	retryMs?: number;
	// Which tabs are on screen ([D-164]); tests inject one. Default: the real
	// document and Web Locks.
	visibility?: VisibilityTracker;
	// Whether this tab drains the outbox now: a follower's edits wait for the
	// leader ([D-288]).
	onLeadership?: (leading: boolean) => void;
}

// „Jetzt senden" in any tab reaches the leader, the one that sends ([D-296]).
const syncNowChannel = new BroadcastChannel('sync-now');
let runNow: (() => void) | null = null;

/** A cycle now, in the leader: here when this tab leads, else in the one that does. */
export function syncNow(): void {
	if (runNow) runNow();
	else syncNowChannel.postMessage('now');
}

/** Starts the loop under leadership; returns its stop(). */
export function startSyncLoop(opts: SyncLoopOptions = {}): () => void {
	const cycleMs = opts.cycleMs ?? 60_000;
	const retryMs = opts.retryMs ?? 5_000;
	// In every tab, not only the leader's: the leader's tick asks it ([D-164]).
	const visibility = opts.visibility ?? trackVisibility();
	const drainOpts: DrainOptions = {
		...opts.drain,
		onDenied: (notice) => {
			opts.drain?.onDenied?.(notice);
			// A lost membership ([D-138]): only a full cycle's digest can tell
			// the list is gone.
			if (notice.reason === 'not_member') cycle();
		}
	};
	// Declared before `cycle`: without Web Locks the first cycle runs
	// synchronously, and reads these.
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	const clearRetry = () => {
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	};
	// A cycle finished within MIN_RETRIGGER_MS already answers a focus.
	const MIN_RETRIGGER_MS = 3000;
	let lastCycleFinished = 0;
	// Running cycles: returning to a tab fires focus and visibilitychange
	// together, and they should cost one cycle.
	let inFlight = 0;
	// What an exchange's outcome tells the status ([D-296]).
	const report = (failed: number, error: unknown) => {
		void recordExchange(failed > 0 ? (error ?? NO_RESULT) : null).catch(() => {});
	};
	const cycle = () => {
		// A retry armed before teardown must not resurrect a stopped loop.
		if (stopped) return;
		clearRetry();
		inFlight++;
		void recordStart().catch(() => {});
		void runSyncCycle({
			...opts,
			drain: drainOpts,
			abandoned: () => stopped || (opts.abandoned?.() ?? false)
		})
			.then((result) => {
				// Not for a stopped loop: onCycle makes network calls.
				if (stopped) return;
				report(result.failed, result.error);
				opts.onCycle?.(result);
				// A push that failed in a cycle whose digest succeeded retries too
				// ([D-139]): resending a frozen layer writes nothing, so no
				// pending_ops change would schedule the next drain.
				if (result.failed > 0 && retryTimer === null) retryTimer = setTimeout(cycle, retryMs);
			})
			.catch((err) => {
				console.error('[sync] cycle failed:', err);
				// A stopped loop must not re-arm its retry.
				if (stopped) return;
				void recordExchange(err).catch(() => {});
				// [D-164]: a transient failure retries soon rather than a tick later.
				retryTimer = setTimeout(cycle, retryMs);
			})
			.finally(() => {
				inFlight--;
				lastCycleFinished = Date.now();
			});
	};

	// The debounced drain on pending_ops changes, subscribed under leadership so
	// only the leader pushes (§8.7, [D-109]).
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let sub: { unsubscribe: () => void } | null = null;
	const scheduleDrain = () => {
		// Not after stop(), nor while a failure retry is pending, which drains
		// first anyway ([D-139]).
		if (stopped || retryTimer !== null) return;
		if (drainTimer) clearTimeout(drainTimer);
		// Behind the cycles, so it never overlaps a cycle's own drain.
		drainTimer = setTimeout(() => {
			if (stopped || retryTimer !== null) return;
			afterCycles(async () => {
				void recordStart().catch(() => {});
				const summary = await drainOutbox(drainOpts).catch((error: unknown) => ({
					drained: 0,
					failed: 1,
					requeued: 0,
					error
				}));
				const { failed } = summary;
				// A drain that sent nothing spoke to no one.
				if (!stopped && summary.drained + summary.failed + summary.requeued > 0) {
					report(failed, summary.error);
				} else if (!stopped) {
					void recordEnd().catch(() => {});
				}
				// An undelivered push hands over to the one failure retry
				// ([D-139]); re-queued ops already scheduled their own drain.
				if (failed > 0 && !stopped && retryTimer === null) {
					retryTimer = setTimeout(cycle, retryMs);
				}
			});
		}, 500);
	};

	const retrigger = () => {
		if (inFlight > 0 || Date.now() - lastCycleFinished < MIN_RETRIGGER_MS) return;
		cycle();
	};
	const onFocus = retrigger;
	// Not `retrigger`: a cycle running at reconnect may have started before the
	// drop, so it cannot stand in for this one ([D-138]).
	const onOnline = () => {
		if (Date.now() - lastCycleFinished < MIN_RETRIGGER_MS) return;
		cycle();
	};
	// [D-164]: coming back on screen catches up for the skipped ticks (a PWA
	// returning from the background fires this, not always focus).
	const onVisibility = () => {
		if (visibility.visibleHere()) retrigger();
	};
	// Offline means the last cycle no longer answers for now ([D-138]).
	const onOffline = () => {
		lastCycleFinished = 0;
	};
	// The idle tick refreshes what someone is looking at, so it skips while every
	// tab is hidden ([D-164]); drains, retries and SSE do not.
	const tick = () => {
		// A running cycle already answers the tick.
		if (inFlight > 0) return;
		if (visibility.visibleHere()) return cycle();
		void visibility.anyVisible().then((any) => {
			if (any) cycle();
		});
	};

	let tickTimer: ReturnType<typeof setInterval> | null = null;

	// Everything that talks to the server starts here, under leadership.
	const startLeaderWork = () => {
		if (stopped) return; // stopped before leadership was granted
		opts.onLeadership?.(true);
		runNow = cycle;
		syncNowChannel.onmessage = () => runNow?.();
		cycle(); // initial cycle on becoming leader
		globalThis.addEventListener?.('focus', onFocus);
		globalThis.addEventListener?.('online', onOnline);
		globalThis.addEventListener?.('offline', onOffline);
		globalThis.document?.addEventListener('visibilitychange', onVisibility);
		tickTimer = globalThis.setInterval(tick, cycleMs);
		sub = liveQuery(() => db.pending_ops.count()).subscribe({
			next: () => scheduleDrain(),
			error: () => {}
		});
	};

	// What startLeaderWork attached: no trigger starts a cycle or a drain after this.
	const detachTriggers = () => {
		if (runNow === cycle) runNow = null;
		globalThis.removeEventListener?.('focus', onFocus);
		globalThis.removeEventListener?.('online', onOnline);
		globalThis.removeEventListener?.('offline', onOffline);
		globalThis.document?.removeEventListener('visibilitychange', onVisibility);
		if (tickTimer !== null) {
			globalThis.clearInterval(tickTimer);
			tickTimer = null;
		}
		if (drainTimer) {
			clearTimeout(drainTimer);
			drainTimer = null;
		}
		sub?.unsubscribe();
		sub = null;
	};

	// Holds the lock until running work is done, so two tabs never settle one
	// outbox at once (leader.ts, onRelease).
	const releaseLeaderWork = async () => {
		opts.onLeadership?.(false);
		detachTriggers();
		syncNowChannel.onmessage = null;
		await cyclesSettled();
	};

	const stopLeadership = requestLeadership(startLeaderWork, { onRelease: releaseLeaderWork });

	return () => {
		if (stopped) return;
		stopped = true;
		detachTriggers();
		stopLeadership();
		clearRetry();
		visibility.stop();
	};
}
