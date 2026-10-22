// When a cycle runs (§8.5, §8.7): on becoming leader, on an idle tick, on
// focus, online and visibility, after a failure; plus a debounced drain on
// every local mutation. What a cycle does is cycle.ts.
import { reportUncaught } from '#lib/client-errors.js';
import { db } from '#lib/db.js';
import { drainOutbox, type DrainOptions } from '#lib/sync/push.js';
import { anySignal } from '#lib/sync/http.js';
import { sessionScope } from '#lib/auth/session.js';
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
	// Aborted by stop(): every cycle and drain carries it, so their requests are
	// cancelled and nothing they queued runs after it ([D-341]).
	const life = new AbortController();
	const { signal } = life;
	const combined = opts.signal ? anySignal([signal, opts.signal]) : { signal, release() {} };
	const work = combined.signal;
	// The loop's own follow-up to a cycle or drain, dropped once it stopped.
	const live =
		<A extends unknown[]>(fn: (...args: A) => void) =>
		(...args: A) => {
			if (!work.aborted) fn(...args);
		};
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
	// One exchange's status ([D-296]), written for the account it started under:
	// none of it lands behind that account's sign-out (§5.6 [D-109]).
	const startExchange = () => {
		const scope = sessionScope();
		const write = (record: Promise<void>) => void record.catch(() => {});
		write(recordStart(new Date(), scope));
		return {
			report: (failed: number, error: unknown) =>
				write(recordExchange(failed > 0 ? (error ?? NO_RESULT) : null, new Date(), scope)),
			fail: (error: unknown) => write(recordExchange(error, new Date(), scope)),
			// Without an outcome: nothing was sent, or it was cancelled.
			end: () => write(recordEnd(new Date(), scope))
		};
	};
	const cycle = live(() => {
		clearRetry();
		inFlight++;
		const exchange = startExchange();
		void runSyncCycle({ ...opts, drain: drainOpts, signal: work })
			.then((result: CycleResult) => {
				// Cancelled (stop() or a sign-out): no outcome, nothing to fan out.
				if (result.cancelled || work.aborted) return exchange.end();
				exchange.report(result.failed, result.error);
				opts.onCycle?.(result);
				// A push that failed in a cycle whose digest succeeded retries too
				// ([D-139]): resending a frozen layer writes nothing, so no
				// pending_ops change would schedule the next drain.
				if (result.failed > 0 && retryTimer === null) retryTimer = setTimeout(cycle, retryMs);
			})
			.catch((err: unknown) => {
				if (work.aborted) return exchange.end();
				console.error('[sync] cycle failed:', err);
				exchange.fail(err);
				// [D-164]: a transient failure retries soon rather than a tick later.
				retryTimer = setTimeout(cycle, retryMs);
			})
			.finally(() => {
				inFlight--;
				lastCycleFinished = Date.now();
			});
	});

	// The debounced drain on pending_ops changes, subscribed under leadership so
	// only the leader pushes (§8.7, [D-109]).
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let sub: { unsubscribe: () => void } | null = null;
	// Not while a failure retry is pending, which drains first anyway ([D-139]).
	const scheduleDrain = live(() => {
		if (retryTimer !== null) return;
		if (drainTimer) clearTimeout(drainTimer);
		// Behind the cycles, so it never overlaps a cycle's own drain.
		drainTimer = setTimeout(
			live(() => {
				if (retryTimer !== null) return;
				afterCycles(async () => {
					const exchange = startExchange();
					const summary = await drainOutbox({ ...drainOpts, signal: work }).catch(
						(error: unknown) => ({ drained: 0, failed: 1, requeued: 0, error })
					);
					if (work.aborted) return exchange.end();
					const { failed } = summary;
					// A drain that sent nothing spoke to no one.
					if (summary.drained + summary.failed + summary.requeued > 0) {
						exchange.report(failed, summary.error);
					} else {
						exchange.end();
					}
					// An undelivered push hands over to the one failure retry
					// ([D-139]); re-queued ops already scheduled their own drain.
					if (failed > 0 && retryTimer === null) retryTimer = setTimeout(cycle, retryMs);
				}, work);
			}),
			500
		);
	});

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
	// Not when stopped before leadership was granted.
	const startLeaderWork = live(() => {
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
			// Dead from here on: no queued change starts a drain but the tick.
			error: (error) => reportUncaught(error, 'outbox count')
		});
	});

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
		if (signal.aborted) return;
		life.abort();
		combined.release();
		detachTriggers();
		stopLeadership();
		clearRetry();
		visibility.stop();
	};
}
