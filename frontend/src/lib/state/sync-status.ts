// What a list says about its sync ([D-296]): one answer for the chip and the
// line under the list's name, the same in every tab. "Synchronisiert" only
// while true; otherwise what is wrong, from what the leader last saw of the
// server (#lib/sync/health), whether this tab leads, and how long the oldest
// change has waited.
import { derived, readable, type Readable } from 'svelte/store';
import type { PendingOp } from '#lib/db.js';
import { authState } from '#lib/auth/index.js';
import {
	leading,
	NO_HEALTH,
	querySyncHealth,
	type SyncFailure,
	type SyncHealth
} from '#lib/sync/index.js';
import { live } from './live';
import { online } from './online';
import { lastSyncedAt, outbox } from './data';

/** A change waiting this long with no exchange started since means the sender is stuck. */
export const STUCK_MS = 20_000;
/** An exchange still under way after this long belongs to a page that froze:
 *  every request times out well inside it (a cycle's push and digest, 25 s). */
export const IN_FLIGHT_MS = 60_000;
/** Failed tries in a row before it says so: one is retried after 5 s anyway. */
const FAILING_AFTER = 3;

export type SyncLine =
	| { kind: 'normal' }
	| { kind: 'offline'; since: string | null }
	| { kind: 'other_tab' }
	| { kind: 'stuck' }
	| { kind: 'failing'; reason: Exclude<SyncFailure, 'app'>; count: number }
	/** `here`: this tab leads, so a reload here can help ([D-288]). */
	| { kind: 'broken'; here: boolean }
	| { kind: 'stale'; since: string | null };

export interface SyncInput {
	online: boolean;
	expired: boolean;
	leading: boolean;
	pending: number;
	oldestQueuedAt: number | null;
	health: SyncHealth;
	lastSyncedAt: string | null;
	now: number;
	/** When this page loaded: a sender gets its first 20 s to start. */
	since: number;
}

function newest(a: string | null, b: string | null): string | null {
	if (!a) return b;
	if (!b) return a;
	return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** The status, by the rules of [D-296], first match wins. */
export function syncLine(input: SyncInput): SyncLine {
	const okAt = newest(input.health.ok_at, input.lastSyncedAt);
	if (!input.online) return { kind: 'offline', since: okAt };
	// The chip's re-auth says it; the line keeps the members.
	if (input.expired) return { kind: 'normal' };
	const startedAt = input.health.started_at ? Date.parse(input.health.started_at) : null;
	const endedAt = input.health.ended_at ? Date.parse(input.health.ended_at) : null;
	// A slow exchange (a hung push, then a hung digest) is no stuck sender.
	const underWay =
		startedAt !== null &&
		endedAt !== null &&
		startedAt > endedAt &&
		input.now - startedAt < IN_FLIGHT_MS;
	const lastSign = Math.max(startedAt ?? -Infinity, endedAt ?? -Infinity);
	const waited = input.oldestQueuedAt === null ? 0 : input.now - input.oldestQueuedAt;
	if (
		input.pending > 0 &&
		waited >= STUCK_MS &&
		input.now - input.since >= STUCK_MS &&
		!underWay &&
		input.now - lastSign >= STUCK_MS
	) {
		return { kind: input.leading ? 'stuck' : 'other_tab' };
	}
	if (input.health.failures < FAILING_AFTER) return { kind: 'normal' };
	// The app's own failure repeats on every try, wherever the server is.
	const reason = input.health.reason ?? 'server';
	if (reason === 'app') return { kind: 'broken', here: input.leading };
	if (input.pending > 0) return { kind: 'failing', reason, count: input.pending };
	return { kind: 'stale', since: okAt };
}

/** The §12.1 chip's state ([D-102]): one glyph, the line says the rest. */
export type ChipState = 'synced' | 'pending' | 'stale' | 'offline' | 'expired';

export interface SyncStatus {
	line: SyncLine;
	chip: ChipState;
	/** The chip's count: the outbox's length. */
	pending: number;
}

/**
 * The line and the chip from one input. Offline wins over expired, since
 * re-auth needs connectivity (§5.8); the count over stale, which needs none
 * pending. `loaded` false (the outbox or the health not read yet) keeps the
 * line normal: the stored state answers first.
 */
export function syncStatusOf(input: SyncInput, loaded = true): SyncStatus {
	const line: SyncLine = loaded ? syncLine(input) : { kind: 'normal' };
	const chip: ChipState = !input.online
		? 'offline'
		: input.expired
			? 'expired'
			: input.pending > 0
				? 'pending'
				: line.kind === 'stale' || line.kind === 'broken'
					? 'stale'
					: 'synced';
	return { line, chip, pending: input.pending };
}

const health = live<SyncHealth>(() => querySyncHealth(), NO_HEALTH, 'meta:sync_health');

// The thresholds are times, so the answer is asked again while nothing moves.
const clock = readable(Date.now(), (set) => {
	const timer = setInterval(() => set(Date.now()), 5_000);
	return () => clearInterval(timer);
});

// A page just loaded gives its sender the time to start before calling it stuck.
const pageLoadedAt = Date.now();

function oldest(ops: PendingOp[]): number | null {
	let at: number | null = null;
	for (const op of ops) {
		const queued = Date.parse(op.queued_at);
		if (!Number.isNaN(queued) && (at === null || queued < at)) at = queued;
	}
	return at;
}

/** The status of `listId`'s sync, or the whole device's for `''` ([D-130]). */
export function syncStatus(listId = ''): Readable<SyncStatus> {
	const ops = outbox(listId);
	return derived(
		[online, authState, leading, ops, ops.loaded, health, health.loaded, lastSyncedAt, clock],
		([$online, $auth, $leading, $ops, $opsLoaded, $health, $healthLoaded, $synced, $now]) =>
			syncStatusOf(
				{
					online: $online,
					expired: $auth.nickname !== null && !$auth.isValid,
					leading: $leading,
					pending: $ops.length,
					oldestQueuedAt: oldest($ops),
					health: $health,
					lastSyncedAt: $synced,
					now: $now,
					since: pageLoadedAt
				},
				$opsLoaded && $healthLoaded
			)
	);
}
