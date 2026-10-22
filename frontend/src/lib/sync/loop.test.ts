import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';
import { db } from '#lib/db.js';
import { trackTimers } from '#lib/test-kit/timers.js';
import { putSynced } from '#lib/test-kit/db.js';
import { cyclesSettled, runSyncCycle, resetReferenceMirrorCheck } from './cycle';
import { startSyncLoop, syncNow } from './loop';
import { getMeta } from '#lib/db.js';
import { SYNC_HEALTH_KEY } from './health';
import { endSession, resetSessionForTest } from '#lib/auth/session.js';

// The loop schedules with plain timers — a failed cycle arms
// setTimeout(cycle, retryMs) and a pending_ops change the 500ms drain
// debounce — so the retry/teardown describes below COUNT them (see
// test-kit/timers.ts) instead of sleeping past a horizon: "a retry happened"
// waits for the observed call count, and "nothing re-arms" is the tracked
// pending count reaching 0, which is exact because an armed timer is
// pending before it can ever fire.
const RETRY = 30;
const DRAIN_DEBOUNCE = 500;
const loopTimers = trackTimers((delay) => delay === RETRY || delay === DRAIN_DEBOUNCE);

// The ambient loop must not let one swallowed transient stall convergence by
// a full ~60s tick (§8.5): a failed cycle re-runs after a fixed short delay.
// Real timers with a tiny injected retryMs — no fake-clock juggling with
// Dexie's internal scheduling. Margins are deliberately generous (20x the
// retry period): under the full three-project cold suite a single attempt can
// take tens of ms, and 5x windows were proven to starve the >= counts there
// (two different tests in this describe flaked on separate full runs while
// passing 3/3 standalone).
describe('startSyncLoop failure retry', () => {
	// The loop logs every failed cycle via console.error — by design, and by
	// the dozen in this describe (each 30ms retry is one). Swallow it here so
	// expected noise stops burying real failures in CI logs. Nothing in this
	// describe asserts on console output (and per snapshot.test.ts's gotcha,
	// no assertion may follow a mockRestore — hence restore-only afterEach).
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.mocked(console.error).mockRestore();
	});

	function loopWithTransientFailure() {
		let shouldFail = true;
		const digestTransport = vi.fn(async () => {
			// No answer, as apiJson throws it.
			if (shouldFail) throw Object.assign(new Error('transient'), { status: 0 });
			return [];
		});
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: RETRY,
			digestTransport,
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		return { stop, digestTransport, setHealthy: () => (shouldFail = false) };
	}

	it('retries failed cycles instead of waiting out the tick', async () => {
		const { stop, digestTransport } = loopWithTransientFailure();
		try {
			// The event, not a window: wait until the initial cycle plus
			// multiple 30ms retries have actually run — impossible if a
			// failure waited for the next 60s tick.
			await vi.waitFor(() => expect(digestTransport.mock.calls.length).toBeGreaterThanOrEqual(4), {
				timeout: 5000
			});
		} finally {
			stop();
		}
	});

	it('stops retrying once a cycle succeeds', async () => {
		const { stop, digestTransport, setHealthy } = loopWithTransientFailure();
		try {
			await vi.waitFor(() => expect(digestTransport.mock.calls.length).toBeGreaterThanOrEqual(3), {
				timeout: 5000
			});

			setHealthy();
			// Wait for the next retry to run — the one that succeeds.
			const before = digestTransport.mock.calls.length;
			await vi.waitFor(() => expect(digestTransport.mock.calls.length).toBeGreaterThan(before), {
				timeout: 5000
			});

			// Success arms neither a retry nor a drain: an armed timer is
			// pending before it can ever fire, so a tracked count of 0 IS
			// the "nothing schedules anymore" proof. The only scheduler left
			// is the 60s interval, far past this test's life.
			await vi.waitFor(() => expect(loopTimers.pending()).toBe(0), { timeout: 5000 });
			expect(digestTransport.mock.calls.length).toBe(before + 1);
		} finally {
			stop();
		}
	});

	// [D-296] Every tab's status reads what the leader saw: failures in a row,
	// cleared by the next exchange that works.
	it('records each failed cycle, and the one that recovers', async () => {
		await db.meta.delete(SYNC_HEALTH_KEY);
		const { stop, setHealthy } = loopWithTransientFailure();
		const health = () => getMeta(SYNC_HEALTH_KEY);
		try {
			await vi.waitFor(async () => expect((await health())?.failures).toBeGreaterThanOrEqual(2), {
				timeout: 5000
			});
			expect((await health())?.reason).toBe('connection');

			setHealthy();
			await vi.waitFor(async () => expect((await health())?.failures).toBe(0), { timeout: 5000 });
			expect((await health())?.ok_at).not.toBeNull();
		} finally {
			stop();
		}
	});

	it('stop() cancels a pending failure retry', async () => {
		const { stop, digestTransport } = loopWithTransientFailure();
		await vi.waitFor(() => expect(digestTransport.mock.calls.length).toBeGreaterThanOrEqual(3), {
			timeout: 5000
		});
		// Catch the loop mid-retry: while failing, a 30ms timer is armed
		// after every failed cycle.
		await vi.waitFor(() => expect(loopTimers.pending()).toBe(1), { timeout: 5000 });

		const atStop = digestTransport.mock.calls.length;
		stop();
		// stop() cleared the armed retry (the tracked pending count dropped
		// with the clearTimeout) and unsubscribed the liveQuery — nothing is
		// left that could re-arm, so no observation window is needed.
		expect(loopTimers.pending()).toBe(0);
		expect(digestTransport.mock.calls.length).toBe(atStop);
	});
});

// [D-138] A list deleted by its last member is learnt only from a full cycle's
// membership set: the other device's queued op comes back denied/not_member,
// and a reconnect must not skip the cycle that fetches it.
describe('startSyncLoop: learning a list is gone', () => {
	const events = new EventTarget();
	beforeEach(async () => {
		await db.pending_ops.clear();
		await db.memberships.clear();
		resetReferenceMirrorCheck();
		vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
		vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
	});

	function startLoop(transport = vi.fn().mockResolvedValue({ results: [] })) {
		const digestTransport = vi.fn().mockResolvedValue([]);
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: RETRY,
			digestTransport,
			drain: { transport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		return { stop, digestTransport };
	}

	it('a not_member denial runs a full cycle, so the membership set shows the loss now', async () => {
		await db.pending_ops.put({
			op_id: 'op-lost',
			collection: 'items',
			record_id: 'item-1',
			list_id: 'list-deleted',
			type: 'update',
			changed: { note: 'x' },
			base: { note: null },
			queued_at: '2026-09-24T08:00:00.000Z'
		});
		const transport = vi.fn().mockImplementation(async (ops: { op_id: string }[]) => ({
			results: ops.map((o) => ({ op_id: o.op_id, status: 'denied', reason: 'not_member' }))
		}));
		const { stop, digestTransport } = startLoop(transport);
		try {
			// The initial cycle's drain is denied; without the trigger the second
			// membership read would wait for the 60s tick.
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(2), {
				timeout: 5000
			});
		} finally {
			stop();
		}
	});

	it('a reconnect right after a cycle still runs one when the connection dropped in between', async () => {
		const { stop, digestTransport } = startLoop();
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			// Within MIN_RETRIGGER_MS of that cycle: before [D-138] this `online`
			// was swallowed as "the last cycle already reflects the world".
			events.dispatchEvent(new Event('offline'));
			events.dispatchEvent(new Event('online'));
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(2), {
				timeout: 5000
			});
		} finally {
			stop();
		}
	});
});

// [D-164] The idle tick is skipped while no tab of the app is on screen, and a
// tab coming back runs a cycle instead.
describe('startSyncLoop: nobody looking', () => {
	const TICK = 20;
	const events = new EventTarget();
	// The server project runs in Node: no document to hear visibilitychange on.
	const doc = new EventTarget();
	beforeEach(async () => {
		await db.pending_ops.clear();
		await db.memberships.clear();
		resetReferenceMirrorCheck();
		vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
		vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
		vi.stubGlobal('document', doc);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function startLoop(here: { visible: boolean }, elsewhere: boolean, cycleMs = TICK) {
		const digestTransport = vi.fn().mockResolvedValue([]);
		const anyVisible = vi.fn(async () => here.visible || elsewhere);
		const stop = startSyncLoop({
			cycleMs,
			retryMs: RETRY,
			digestTransport,
			visibility: { visibleHere: () => here.visible, anyVisible, stop: vi.fn() },
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		return { stop, digestTransport, anyVisible };
	}

	it('skips the tick while every tab is hidden', async () => {
		const { stop, digestTransport, anyVisible } = startLoop({ visible: false }, false);
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			// Ticks happened (each one asked), and none of them cycled.
			await vi.waitFor(() => expect(anyVisible.mock.calls.length).toBeGreaterThanOrEqual(3), {
				timeout: 5000
			});
			expect(digestTransport).toHaveBeenCalledTimes(1);
		} finally {
			stop();
		}
	});

	it('keeps ticking in a hidden leader while another tab is on screen', async () => {
		const { stop, digestTransport } = startLoop({ visible: false }, true);
		try {
			await vi.waitFor(() => expect(digestTransport.mock.calls.length).toBeGreaterThanOrEqual(3), {
				timeout: 5000
			});
		} finally {
			stop();
		}
	});

	it('runs a cycle when the tab comes back on screen', async () => {
		const here = { visible: false };
		const { stop, digestTransport } = startLoop(here, false, 60_000);
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			// Past the finished-cycle window, as after any real time away.
			const later = Date.now() + 10_000;
			vi.spyOn(Date, 'now').mockReturnValue(later);
			here.visible = true;
			doc.dispatchEvent(new Event('visibilitychange'));
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(2), {
				timeout: 5000
			});
		} finally {
			stop();
		}
	});

	it('returning fires focus and visibilitychange together, and that is one cycle', async () => {
		const here = { visible: false };
		const { stop, digestTransport } = startLoop(here, false, 60_000);
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
			here.visible = true;
			doc.dispatchEvent(new Event('visibilitychange'));
			events.dispatchEvent(new Event('focus'));
			// Cycles in a tab run one after another on one module-level queue, so
			// a cycle of our own queued now settles only after everything the pair
			// started — no observation window needed for the "not twice".
			await runSyncCycle({
				drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
				digestTransport: vi.fn().mockResolvedValue([]),
				snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
				snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] })
			});
			expect(digestTransport).toHaveBeenCalledTimes(2);
		} finally {
			stop();
		}
	});
});

// [D-139] The drain marks its batch sent before pushing, and that write wakes
// the pending_ops watcher — so a failing push must hand over to the retry, or
// it would re-arm itself every 500ms for as long as the link stayed down.
describe('startSyncLoop: a failed push', () => {
	const PUSH_RETRY = 40_000;

	it('hands over to the one failure retry instead of re-pushing every 500ms', async () => {
		resetReferenceMirrorCheck();
		await db.pending_ops.clear();
		await db.memberships.clear();
		const retryTimers = trackTimers((delay) => delay === PUSH_RETRY);
		const drainTimers = trackTimers((delay) => delay === DRAIN_DEBOUNCE);
		const transport = vi.fn().mockRejectedValue(new Error('offline'));
		const digestTransport = vi.fn().mockResolvedValue([]);
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: PUSH_RETRY,
			digestTransport,
			drain: { transport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			await db.pending_ops.put({
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-1',
				list_id: 'list-1',
				type: 'update',
				changed: { note: 'x' },
				base: { note: null },
				queued_at: '2026-09-24T08:00:00.000Z'
			});
			await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1), { timeout: 5000 });
			// The failed push armed the retry...
			await vi.waitFor(() => expect(retryTimers.pending()).toBe(1), { timeout: 5000 });
			// ...and the drain its own write scheduled fires without pushing again.
			await vi.waitFor(() => expect(drainTimers.pending()).toBe(0), { timeout: 5000 });
			expect(transport).toHaveBeenCalledTimes(1);
			expect(retryTimers.pending()).toBe(1);
		} finally {
			stop();
			drainTimers.dispose();
			retryTimers.dispose();
		}
	});

	// The retry resends the frozen layer without writing, so no watcher wakes:
	// a cycle whose push fails while its digest succeeds must re-arm the retry
	// itself, or the edit waits for a tick that a hidden PWA never runs ([D-164]).
	it('keeps retrying while the push fails and the digest succeeds', async () => {
		resetReferenceMirrorCheck();
		await db.pending_ops.clear();
		await db.memberships.clear();
		const transport = vi.fn().mockRejectedValue(new Error('push timed out'));
		const digestTransport = vi.fn().mockResolvedValue([]);
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 35,
			digestTransport,
			drain: { transport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			await db.pending_ops.put({
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-1',
				list_id: 'list-1',
				type: 'update',
				changed: { note: 'x' },
				base: { note: null },
				queued_at: '2026-09-24T08:00:00.000Z'
			});
			// The debounced drain, then one retry cycle after another.
			await vi.waitFor(() => expect(transport.mock.calls.length).toBeGreaterThanOrEqual(4), {
				timeout: 5000
			});
		} finally {
			stop();
		}
	});
});

// An edit coalesced into an op while its push is in flight keeps the op queued
// (push.ts settleRecord). That is not a delivery failure: counted as one, it
// would arm the 5s failure retry and suppress the debounced drain, so the edit
// would wait for a full cycle instead of going out 500ms later.
describe('startSyncLoop: an edit made while its op is in flight', () => {
	const PUSH_RETRY = 40_000;

	it('goes out on the next debounced drain, without arming the failure retry', async () => {
		resetReferenceMirrorCheck();
		await db.pending_ops.clear();
		await db.memberships.clear();
		const retryTimers = trackTimers((delay) => delay === PUSH_RETRY);
		const row = {
			id: 'item-1',
			list: 'list-1',
			name: 'Milk',
			name_de: null,
			name_en: null,
			quantity: '1',
			note: null,
			category_key: null,
			checked: false,
			checked_at: null,
			last_bought_at: null,
			barcode: null,
			image_url: null,
			modified_by: null,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2026-01-01T00:00:00.000Z',
			deleted_at: null
		};
		await putSynced([row]);
		const { updateRecord } = await import('./outbox');
		const sent: Record<string, unknown>[] = [];
		const transport = vi.fn(async (ops: { op_id: string; changed?: Record<string, unknown> }[]) => {
			sent.push({ ...ops[0].changed });
			if (sent.length === 1) {
				// The user edits the note while the quantity push is on the wire.
				await updateRecord('items', (await db.items.get(row.id))!, { note: 'bio' });
			}
			return {
				results: ops.map((op) => ({
					op_id: op.op_id,
					status: 'applied' as const,
					record: { ...row, ...op.changed, updated: `srv-${sent.length}` }
				}))
			};
		});
		const digestTransport = vi.fn().mockResolvedValue([]);
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: PUSH_RETRY,
			digestTransport,
			drain: { transport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1), {
				timeout: 5000
			});
			await updateRecord('items', row, { quantity: '2' });
			await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2), { timeout: 5000 });
			expect(sent).toEqual([{ quantity: '2' }, { note: 'bio' }]);
			expect(retryTimers.pending()).toBe(0);
			await vi.waitFor(async () => expect(await db.pending_ops.count()).toBe(0), {
				timeout: 5000
			});
		} finally {
			stop();
			retryTimers.dispose();
		}
	});
});

// Teardown completeness: stop() must leave no path that still does work —
// a cycle queued behind cycleTail is dropped via its aborted signal, a liveQuery
// emission after teardown must not re-arm the debounced drain, and a dropped
// cycle must not fan out to onCycle.
describe('startSyncLoop teardown', () => {
	function healthyLoop() {
		const digestTransport = vi.fn().mockResolvedValue([]);
		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		const onCycle = vi.fn();
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			digestTransport,
			drain: { transport: drainTransport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			},
			onCycle
		});
		return { stop, digestTransport, drainTransport, onCycle };
	}

	// [D-296] „Jetzt senden“ runs a cycle in the leader at once.
	it('runs a cycle now when asked, while it leads', async () => {
		const digestTransport = vi.fn().mockResolvedValue([]);
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			digestTransport,
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		try {
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(1));
			syncNow();
			await vi.waitFor(() => expect(digestTransport).toHaveBeenCalledTimes(2));
		} finally {
			stop();
		}
	});

	it('reports leading while it leads, and not after stop() ([D-288])', async () => {
		const onLeadership = vi.fn();
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport: vi.fn().mockResolvedValue([]),
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			},
			onLeadership
		});
		expect(onLeadership.mock.calls).toEqual([[true]]);
		stop();
		await vi.waitFor(() => expect(onLeadership.mock.calls).toEqual([[true], [false]]));
	});

	it('runSyncCycle with an aborted signal touches nothing and settles empty', async () => {
		const digestTransport = vi.fn().mockResolvedValue([]);
		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		const result = await runSyncCycle({
			digestTransport,
			drain: { transport: drainTransport },
			signal: AbortSignal.abort()
		});
		expect(result).toEqual({
			drained: 0,
			failed: 0,
			diverged: [],
			purged: [],
			mirrored: false,
			cancelled: true
		});
		expect(digestTransport).not.toHaveBeenCalled();
		expect(drainTransport).not.toHaveBeenCalled();
	});

	it('a cycle that finishes after stop() does not fan out to onCycle', async () => {
		// The drain transport blocks on a manual gate, so the initial cycle is
		// provably in flight when stop() runs — then the gate opens and the
		// cycle completes into a torn-down loop. (Seeded op first: an empty
		// outbox never reaches the transport, so there would be nothing to
		// block on.)
		await db.pending_ops.add({
			op_id: 'op-gated',
			collection: 'items',
			record_id: 'item-g',
			list_id: 'list-g',
			type: 'create',
			changed: { name: 'G' },
			base: {},
			queued_at: new Date().toISOString()
		});
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		// The transport's resolution is the observable the test controls —
		// the flag flips when the drain's request settles, immediately before
		// the cycle's downstream continuation (the guarded onCycle fan-out)
		// gets its turn.
		let transported = false;
		const drainTransport = vi.fn().mockImplementation(() =>
			gate.then(() => {
				transported = true;
				return { results: [] };
			})
		);
		const onCycle = vi.fn();
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			drain: { transport: drainTransport },
			digestTransport: vi.fn().mockResolvedValue([]),
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			},
			onCycle
		});
		try {
			// The initial cycle reaches the transport (it is provably in
			// flight — that is the point of the gate).
			await vi.waitFor(() => expect(drainTransport.mock.calls.length).toBeGreaterThan(0), {
				timeout: 5000
			});
			stop();
			release();
			// Wait for the completion event: the gated transport resolved.
			// The cycle's continuation chain (the guarded onCycle fan-out,
			// any post-failure retry arming) is downstream of that promise
			// and settles within the following macrotask — the flush below
			// yields exactly that queue, not a time window.
			await vi.waitFor(() => expect(transported).toBe(true), { timeout: 5000 });
			await new Promise((r) => setTimeout(r, 0));
			expect(onCycle).not.toHaveBeenCalled();
			// Nothing armed either: a post-teardown retry or drain would be
			// a tracked pending timer first.
			expect(loopTimers.pending()).toBe(0);
		} finally {
			release();
			stop();
		}
	});

	// The debounced drain waits behind a running cycle (afterCycles). Its timer
	// can fire before stop() and its push run after it, once the cycle ends.
	it('a drain queued behind a running cycle does not push after stop()', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let digestCalls = 0;
		const digestTransport = vi.fn().mockImplementation(() => {
			digestCalls++;
			return gate.then(() => []);
		});
		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			digestTransport,
			drain: { transport: drainTransport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		try {
			// The initial cycle is held at its digest, so it is still running.
			await vi.waitFor(() => expect(digestCalls).toBe(1), { timeout: 5000 });
			await db.pending_ops.add({
				op_id: 'op-queued',
				collection: 'items',
				record_id: 'item-q',
				list_id: 'list-q',
				type: 'create',
				changed: { name: 'Q' },
				base: {},
				queued_at: new Date().toISOString()
			});
			// The write arms the debounce, and it fires: the drain is queued.
			await vi.waitFor(() => expect(loopTimers.pending()).toBe(1), { timeout: 5000 });
			await vi.waitFor(() => expect(loopTimers.pending()).toBe(0), { timeout: 5000 });

			stop();
			const drainsAtStop = drainTransport.mock.calls.length;
			release();
			await cyclesSettled();

			expect(drainTransport.mock.calls.length).toBe(drainsAtStop);
		} finally {
			release();
			stop();
		}
	});

	// [D-341] stop() cancels what is under way, not only what comes after: the
	// transports get the loop's signal, and fetch aborts on it.
	it('a request in flight at stop() has its signal aborted', async () => {
		let pushSignal: AbortSignal | undefined;
		const drainTransport = vi.fn().mockImplementation((_ops: unknown, signal?: AbortSignal) => {
			pushSignal = signal;
			// Never answers on its own; rejects on abort, as fetch does.
			return new Promise((_, reject) =>
				signal?.addEventListener('abort', () => reject(signal.reason as Error))
			);
		});
		await db.pending_ops.add({
			op_id: 'op-in-flight',
			collection: 'items',
			record_id: 'item-f',
			list_id: 'list-f',
			type: 'create',
			changed: { name: 'F' },
			base: {},
			queued_at: new Date().toISOString()
		});
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			digestTransport: vi.fn().mockResolvedValue([]),
			drain: { transport: drainTransport },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		try {
			await vi.waitFor(() => expect(pushSignal).toBeDefined(), { timeout: 5000 });
			expect(pushSignal?.aborted).toBe(false);
			stop();
			expect(pushSignal?.aborted).toBe(true);
			await cyclesSettled();
		} finally {
			stop();
			await db.pending_ops.delete('op-in-flight');
		}
	});

	// A sign-out cancels the cycle's request: that ends the cycle as cancelled,
	// not as a sync that worked (no onCycle) nor one that failed (no retry).
	it('a sign-out during a request ends the cycle as cancelled', async () => {
		let digestSignal: AbortSignal | undefined;
		const digestTransport = vi.fn().mockImplementation((signal?: AbortSignal) => {
			digestSignal = signal;
			return new Promise((_, reject) =>
				signal?.addEventListener('abort', () => reject(signal.reason as Error))
			);
		});
		const onCycle = vi.fn();
		const stop = startSyncLoop({
			cycleMs: 60_000,
			retryMs: 30,
			digestTransport,
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			},
			onCycle
		});
		try {
			await vi.waitFor(() => expect(digestSignal).toBeDefined(), { timeout: 5000 });
			endSession();
			expect(digestSignal?.aborted).toBe(true);
			await cyclesSettled();
			// Several retry periods (30ms): a cancelled cycle arms no retry.
			await new Promise((r) => setTimeout(r, 150));
			expect(onCycle).not.toHaveBeenCalled();
			expect(digestTransport).toHaveBeenCalledTimes(1);
		} finally {
			stop();
			resetSessionForTest();
		}
	});

	it('no work happens after stop() (steady state)', async () => {
		const { stop, digestTransport, drainTransport, onCycle } = healthyLoop();
		try {
			// The initial cycle completing is onCycle's first call — its
			// drain ran while healthy.
			await vi.waitFor(() => expect(onCycle.mock.calls.length).toBeGreaterThanOrEqual(1), {
				timeout: 5000
			});
			expect(digestTransport.mock.calls.length).toBeGreaterThanOrEqual(1);

			stop();
			const drainsAtStop = drainTransport.mock.calls.length;
			const cyclesAtStop = digestTransport.mock.calls.length;
			const onCycleAtStop = onCycle.mock.calls.length;

			// A mutation landing after teardown: liveQuery fires scheduleDrain.
			// A sentinel liveQuery on the same table proves Dexie BROADCAST
			// the write — if the loop's subscription survived stop(), its
			// scheduleDrain would have armed the 500ms drain synchronously in
			// the same delivery, and the armed timer would still be pending
			// (or already fired) at the check below. One macrotask flush
			// covers the delivery, not a sleep past the debounce.
			const writeBroadcast = new Promise<void>((resolveBroadcast) => {
				const sentinel = liveQuery(() => db.pending_ops.count()).subscribe({
					next: (count) => {
						if (count >= 1) {
							sentinel.unsubscribe();
							resolveBroadcast();
						}
					},
					error: () => {}
				});
			});
			await db.pending_ops.add({
				op_id: 'op-after-stop',
				collection: 'items',
				record_id: 'item-x',
				list_id: 'list-x',
				type: 'create',
				changed: { name: 'X' },
				base: {},
				queued_at: new Date().toISOString()
			});
			await writeBroadcast;
			await new Promise((r) => setTimeout(r, 0));

			expect(drainTransport.mock.calls.length).toBe(drainsAtStop);
			expect(digestTransport.mock.calls.length).toBe(cyclesAtStop);
			expect(onCycle.mock.calls.length).toBe(onCycleAtStop);
			// And nothing is armed: a re-armed drain would be a tracked
			// pending timer, standing or already fired.
			expect(loopTimers.pending()).toBe(0);
		} finally {
			stop();
		}
	});
});
