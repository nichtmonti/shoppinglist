// Where the engine is bound to the app: the loop once per session (under
// leadership, §8.7), SSE for the list on screen (§8.5), the roster after
// cycles (§7.4), and the notices the app hands in (the root layout's
// #lib/state/sync-notices).
import { db } from '#lib/db.js';
import { startSyncLoop, syncNow } from '#lib/sync/loop.js';
import { runSyncCycle } from '#lib/sync/cycle.js';
import { subscribe } from '#lib/sync/sse.js';
import { refreshRoster } from '#lib/sync/roster.js';
import { setLeading } from '#lib/sync/leading.js';
import type { SyncNotices } from './types';

// ---- the loop ----------------------------------------------------------

let stopLoop: (() => void) | null = null;
/** The app's notices, kept past unmount for a pull that outlives the session. */
let notices: SyncNotices = {};
/** Lists whose roster this session has fetched (or is fetching). */
const rostersRefreshed = new Set<string>();

/** Starts the engine for this session, raising `appNotices`; a second call is a no-op. */
export function mountSync(appNotices: SyncNotices): void {
	if (stopLoop) return;
	notices = appNotices;
	rostersRefreshed.clear();
	stopLoop = startSyncLoop({
		drain: notices,
		onLeadership: setLeading,
		onCycle: () => {
			void refreshNewRosters();
			// A completed cycle proves the connection: retry a failed subscribe
			// for the open list ([D-164]).
			if (activeListId) void setActiveList(activeListId);
		}
	});
}

export function unmountSync(): void {
	stopLoop?.();
	stopLoop = null;
}

/**
 * Pulls what an online-only route made (index.ts, 3.). Pull only: the outbox
 * is the loop's, drained by the leader tab alone (§8.7 [D-109]) and with the
 * notices; drained here, a conflict or a denial would pass in silence. A list
 * the pull finds gone still raises §8.6's notice. Best-effort: the route has
 * already succeeded. A failed pull asks the loop for a cycle at once, which
 * retries within seconds, instead of leaving a list just made or joined
 * "not found" until the loop's next tick.
 */
export async function pullFromServer(): Promise<void> {
	await runSyncCycle({ push: false, drain: notices }).catch(() => syncNow());
}

/**
 * §7.4 trigger (a): after each cycle, the roster of every list this session
 * has not fetched yet, joined mid-session ones included. A failure retries next
 * cycle.
 */
async function refreshNewRosters(): Promise<void> {
	const memberships = await db.memberships.toArray();
	await Promise.all(
		memberships
			.filter((m) => !rostersRefreshed.has(m.list))
			.map((m) => {
				rostersRefreshed.add(m.list);
				return refreshRoster(m.list).catch(() => {
					// offline / not a member any more: try again next cycle
					rostersRefreshed.delete(m.list);
				});
			})
	);
}

// ---- the active list (SSE) ---------------------------------------------

let activeListId: string | null = null;
let unsubscribeSse: (() => Promise<void>) | null = null;
let sseGeneration = 0;
let sseAttempt: Promise<void> | null = null;

/**
 * Binds SSE to the list on screen (`null` on leave). Navigation can outrun the
 * subscribe, so a subscription that arrives for a list no longer active tears
 * itself down (the generation number).
 */
export async function setActiveList(listId: string | null): Promise<void> {
	// Same list: done if subscribed, join an attempt in flight, else retry.
	if (listId === activeListId) {
		if (listId === null || unsubscribeSse) return;
		if (sseAttempt) return sseAttempt;
	}
	activeListId = listId;
	const generation = ++sseGeneration;

	const attempt = (async () => {
		const previous = unsubscribeSse;
		unsubscribeSse = null;
		if (previous) await previous().catch(() => {});

		if (!listId) return;
		try {
			const unsubscribe = await subscribe(listId);
			if (generation !== sseGeneration) {
				await unsubscribe().catch(() => {});
				return;
			}
			unsubscribeSse = unsubscribe;
		} catch {
			// Offline or expired: the digest is the authority anyway (§8.5), and
			// the next completed cycle retries.
		}
	})();
	sseAttempt = attempt;
	try {
		await attempt;
	} finally {
		if (sseAttempt === attempt) sseAttempt = null;
	}
}
