// What the leader last saw of the server ([D-296]): when an exchange last
// worked, when it last started one, and why the tries since have failed. Kept in
// `meta`, so every tab shows the same status (#lib/state/sync-status) and not
// only the leader, which may be hidden.
import { db, getMeta, setMeta } from '#lib/db.js';
import { httpStatus } from '#lib/http-status.js';

/** Why a send or a cycle failed, as far as the user can act on it. */
export type SyncFailure = 'connection' | 'server' | 'rate';

export interface SyncHealth {
	ok_at: string | null; // the last exchange that worked
	started_at: string | null; // when the last one started: a sender that starts none is stuck
	ended_at?: string | null; // when the last one ended: between the two, one is under way
	failures: number; // in a row since ok_at
	reason: SyncFailure | null; // the last failure's
}

export const SYNC_HEALTH_KEY = 'sync_health';

export const NO_HEALTH: SyncHealth = {
	ok_at: null,
	started_at: null,
	ended_at: null,
	failures: 0,
	reason: null
};

/** A send the server answered without a result for: its fault, not the network's. */
export const NO_RESULT = Object.assign(new Error('no result'), { status: 500 });

/** A 429 is the rate limit, any other answer the server; no answer is the connection. */
export function failureOf(error: unknown): SyncFailure {
	const status = httpStatus(error);
	if (status === 429) return 'rate';
	if (status !== undefined && status > 0) return 'server';
	return 'connection';
}

async function update(change: (prev: SyncHealth) => SyncHealth): Promise<void> {
	await db.transaction('rw', db.meta, async () => {
		const prev = (await getMeta(SYNC_HEALTH_KEY)) ?? NO_HEALTH;
		await setMeta(SYNC_HEALTH_KEY, change(prev));
	});
}

/** Records that an exchange starts. */
export function recordStart(at = new Date()): Promise<void> {
	return update((prev) => ({ ...prev, started_at: at.toISOString() }));
}

/** Records how one ended: `null` for one that worked, else what failed. */
export function recordExchange(error: unknown, at = new Date()): Promise<void> {
	const ended_at = at.toISOString();
	return update((prev) =>
		error === null
			? { ...prev, ended_at, ok_at: ended_at, failures: 0, reason: null }
			: { ...prev, ended_at, failures: prev.failures + 1, reason: failureOf(error) }
	);
}

/** Records that one ended without speaking to the server: a drain with nothing to send. */
export function recordEnd(at = new Date()): Promise<void> {
	return update((prev) => ({ ...prev, ended_at: at.toISOString() }));
}
