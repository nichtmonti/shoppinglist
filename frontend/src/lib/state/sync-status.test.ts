// [D-296] What a list says about its sync, rule by rule: the first that holds
// wins, and "synchronisiert" is said only while it is true.
import { describe, expect, it } from 'vitest';
import { NO_HEALTH, type SyncHealth } from '#lib/sync/index.js';
import { syncLine, syncStatusOf, IN_FLIGHT_MS, STUCK_MS, type SyncInput } from './sync-status';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function input(over: Partial<SyncInput> = {}, health: Partial<SyncHealth> = {}): SyncInput {
	return {
		online: true,
		expired: false,
		leading: true,
		pending: 0,
		oldestQueuedAt: null,
		health: { ...NO_HEALTH, ok_at: ago(10_000), started_at: ago(10_000), ...health },
		lastSyncedAt: null,
		now: NOW,
		since: NOW - 3_600_000,
		...over
	};
}

describe('syncLine', () => {
	it('is quiet while everything is fine, and while a change is on its way', () => {
		expect(syncLine(input())).toEqual({ kind: 'normal' });
		expect(syncLine(input({ pending: 2, oldestQueuedAt: NOW - 1_000 }))).toEqual({
			kind: 'normal'
		});
	});

	it('says offline first, with when it last heard from the server', () => {
		expect(syncLine(input({ online: false, pending: 3, oldestQueuedAt: NOW - 60_000 }))).toEqual({
			kind: 'offline',
			since: ago(10_000)
		});
	});

	it('leaves an expired session to the chip', () => {
		expect(
			syncLine(input({ expired: true, pending: 3, oldestQueuedAt: NOW - 60_000 }, { failures: 5 }))
		).toEqual({ kind: 'normal' });
	});

	it('names the reason once three tries in a row have failed, not before', () => {
		const waiting = { pending: 3, oldestQueuedAt: NOW - 10_000 };
		expect(syncLine(input(waiting, { failures: 2, reason: 'rate' }))).toEqual({ kind: 'normal' });
		expect(syncLine(input(waiting, { failures: 3, reason: 'rate' }))).toEqual({
			kind: 'failing',
			reason: 'rate',
			count: 3
		});
	});

	it('tells a stuck sender here from one in another tab', () => {
		const stuck = { pending: 2, oldestQueuedAt: NOW - STUCK_MS };
		const silent = { started_at: ago(STUCK_MS) };
		expect(syncLine(input({ ...stuck, leading: true }, silent))).toEqual({ kind: 'stuck' });
		expect(syncLine(input({ ...stuck, leading: false }, silent))).toEqual({ kind: 'other_tab' });
	});

	// [D-288] counted only changes nobody had tried; one tried and failed in a
	// tab that is now suspended waits just the same.
	it('counts a change tried and failed before its sender went quiet', () => {
		expect(
			syncLine(
				input(
					{ leading: false, pending: 1, oldestQueuedAt: NOW - 120_000 },
					{ started_at: ago(60_000), failures: 4, reason: 'connection' }
				)
			)
		).toEqual({ kind: 'other_tab' });
	});

	// A cycle on a link that drops packets: its push times out after 15 s,
	// then its digest after 10 s more, so one exchange runs past 20 s.
	it('is not stuck while a slow exchange is still under way', () => {
		const waiting = { pending: 1, oldestQueuedAt: NOW - 45_000 };
		const slow = { started_at: ago(STUCK_MS + 5_000), ended_at: ago(STUCK_MS + 10_000) };
		expect(syncLine(input(waiting, slow))).toEqual({ kind: 'normal' });
		// Ended and quiet since: stuck.
		const quiet = { started_at: ago(STUCK_MS + 10_000), ended_at: ago(STUCK_MS + 5_000) };
		expect(syncLine(input(waiting, quiet))).toEqual({ kind: 'stuck' });
		// Under way for over a minute: the page that runs it froze.
		const frozen = { started_at: ago(IN_FLIGHT_MS), ended_at: ago(IN_FLIGHT_MS + 5_000) };
		expect(syncLine(input({ ...waiting, leading: false }, frozen))).toEqual({ kind: 'other_tab' });
	});

	// A page just loaded: its sender has not had the time to start yet.
	it('gives a page just loaded its first 20 s before calling anything stuck', () => {
		expect(
			syncLine(
				input(
					{ pending: 2, oldestQueuedAt: NOW - 3_600_000, since: NOW - 5_000 },
					{ started_at: ago(3_600_000) }
				)
			)
		).toEqual({ kind: 'normal' });
	});

	it('is not stuck while tries keep coming, even failing ones', () => {
		expect(
			syncLine(
				input(
					{ pending: 1, oldestQueuedAt: NOW - 120_000 },
					{ started_at: ago(4_000), failures: 9, reason: 'server' }
				)
			)
		).toMatchObject({ kind: 'failing' });
	});

	// Nothing of the user's waits, but what others change is not arriving.
	it('says how old what is shown is after three failed tries with nothing waiting', () => {
		const health = { ok_at: ago(20_000), started_at: ago(5_000), reason: 'connection' as const };
		expect(syncLine(input({}, { ...health, failures: 2 }))).toEqual({ kind: 'normal' });
		expect(syncLine(input({}, { ...health, failures: 3 }))).toEqual({
			kind: 'stale',
			since: ago(20_000)
		});
	});

	// The app's own failure is no passing outage: it says so, whatever waits.
	it('calls the sync broken after three failures of the app itself', () => {
		const broken = { started_at: ago(5_000), failures: 3, reason: 'app' as const };
		expect(syncLine(input({}, broken))).toEqual({ kind: 'broken' });
		expect(syncLine(input({ pending: 2, oldestQueuedAt: NOW - 1_000 }, broken))).toEqual({
			kind: 'broken'
		});
		expect(syncLine(input({}, { ...broken, failures: 2 }))).toEqual({ kind: 'normal' });
	});

	// A tab back from the background syncs at once: until it has tried and
	// failed, an old answer is not news.
	it('is not stale for a long silence with no failed try', () => {
		expect(syncLine(input({}, { ok_at: ago(3 * 3_600_000), failures: 0 }))).toEqual({
			kind: 'normal'
		});
	});

	it('takes the newer of the last good exchange and the last full cycle', () => {
		expect(
			syncLine(
				input(
					{ lastSyncedAt: ago(60_000) },
					{ ok_at: ago(600_000), started_at: ago(5_000), failures: 3 }
				)
			)
		).toEqual({ kind: 'stale', since: ago(60_000) });
	});
});

// §12.1, [D-102]: the chip reads the same answer as the line, one glyph per state.
describe('syncStatusOf', () => {
	const chip = (over: Partial<SyncInput>, health: Partial<SyncHealth> = {}, loaded = true) =>
		syncStatusOf(input(over, health), loaded).chip;

	it('is synced while nothing waits, and counts what does', () => {
		expect(chip({})).toBe('synced');
		expect(syncStatusOf(input({ pending: 3, oldestQueuedAt: NOW - 1_000 }))).toEqual({
			line: { kind: 'normal' },
			chip: 'pending',
			pending: 3
		});
	});

	it('says offline over an expired session: re-auth needs the network', () => {
		expect(chip({ online: false, expired: true, pending: 2 })).toBe('offline');
		expect(chip({ expired: true, pending: 2 })).toBe('expired');
	});

	it('shows the count, not the line, when changes are stuck or failing', () => {
		expect(
			chip({ pending: 2, oldestQueuedAt: NOW - STUCK_MS }, { started_at: ago(STUCK_MS) })
		).toBe('pending');
		expect(chip({ pending: 2 }, { failures: 3 })).toBe('pending');
	});

	it('wears the clock when the line says stale or broken', () => {
		const stale = { failures: 4, ok_at: ago(60_000) };
		expect(chip({}, stale)).toBe('stale');
		expect(chip({}, { ...stale, reason: 'app' })).toBe('stale');
		expect(chip({ pending: 1, oldestQueuedAt: NOW - 1_000 }, { ...stale, reason: 'app' })).toBe(
			'pending'
		);
		// Before the stored state is read, nothing is said from defaults.
		expect(syncStatusOf(input({}, stale), false)).toEqual({
			line: { kind: 'normal' },
			chip: 'synced',
			pending: 0
		});
		expect(chip({ online: false }, stale, false)).toBe('offline');
	});
});
