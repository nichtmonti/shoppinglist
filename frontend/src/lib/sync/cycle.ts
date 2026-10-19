// One sync cycle (§8.5), serialized per tab. loop.ts decides when one runs.
import { db, setMeta, type Membership } from '#lib/db.js';
import { drainOutbox, type DrainOptions } from '#lib/sync/push.js';
import {
	computeDivergence,
	fetchServerDigest,
	localDigests,
	type DigestTransport
} from '#lib/sync/digest.js';
import {
	reconcileDivergedLists,
	type SnapshotFetcher,
	type SnapshotIdsFetcher
} from '#lib/sync/snapshot.js';
import { checkAndMirrorReference, type MirrorOptions } from '#lib/sync/mirror.js';
import { isAuthRejected, markAuthExpired } from '#lib/auth/state.js';
import { sessionScope } from '#lib/auth/session.js';
import type { Table } from 'dexie';
import { purgeGoneList } from './purge';
import type { DigestEntry } from './types';

// Injectable dependency bundle for the cycle (so tests pass fakes for every external call).
export interface CycleDeps {
	drain?: DrainOptions; // drainOutbox's transport and the notices (onGone also for the purge)
	// false: pull only, and leave the outbox to the loop (mount.ts pullFromServer).
	push?: boolean;
	digestTransport?: DigestTransport; // GET /api/sync/digest
	snapshotFetcher?: SnapshotFetcher; // reconcileDivergedLists ([D-40] delta and full snapshot)
	snapshotIdsFetcher?: SnapshotIdsFetcher; // reconcileDivergedLists ([D-40] id set)
	mirror?: MirrorOptions; // seed_version re-mirror
	// Whether the caller has stopped: a queued cycle can start long after its
	// caller tore down, so it checks this before every network call and write.
	abandoned?: () => boolean;
}

export interface CycleResult {
	drained: number; // from drainOutbox
	failed: number; // ops drainOutbox could not deliver; the loop retries them ([D-139])
	diverged: string[]; // lists reconciled
	purged: string[]; // lists purged (vanished)
	mirrored: boolean; // whether a reference re-mirror happened
	error?: unknown; // what stopped the drain, if a send failed ([D-296])
}

// The seed_version re-mirror check runs once per page session (§6.12): the
// reference data changes only with a new seed.
let referenceMirrorChecked = false;

/** Test seam: the flag lives as long as the module. */
export function resetReferenceMirrorCheck(): void {
	referenceMirrorChecked = false;
}

/**
 * Reject a membership set that is not the API's own data ([D-28]). The purge
 * treats an empty set as authoritative, so shape is the test, not length; a
 * malformed body aborts the cycle like a network failure, and nothing is purged.
 */
function assertMembershipData(recs: unknown): asserts recs is Membership[] {
	if (!Array.isArray(recs)) throw new Error('sync: memberships response is not a list');
	for (const r of recs as Record<string, unknown>[]) {
		if (typeof r?.id !== 'string' || typeof r.list !== 'string' || typeof r.account !== 'string') {
			throw new Error('sync: memberships response is not membership data');
		}
	}
}

// Cycles run one after another in a tab. Leadership (§8.7) only separates
// tabs; inside one, the loop's triggers and the inline calls from createList()
// and joinList() would overlap, and the SDK cancels an in-flight request when
// an identical one starts. A tail chain, not "join the queued cycle": each
// caller brings its own CycleDeps.
let cycleTail: Promise<unknown> = Promise.resolve();

export function runSyncCycle(deps: CycleDeps = {}): Promise<CycleResult> {
	const next = cycleTail.then(
		() => executeSyncCycle(deps),
		() => executeSyncCycle(deps) // a failed predecessor must not poison the chain
	);
	// Keep the chain alive regardless of THIS cycle's outcome; the caller still sees the rejection.
	cycleTail = next.catch(() => {});
	return next;
}

/**
 * Queue `work` on the same chain as the cycles, so it never overlaps one in
 * this tab. The loop's debounced drain goes through here: two concurrent
 * drains on the same outbox can settle a stale server record over a newer
 * local edit (push.ts settleRecord). `work` must not reject.
 */
export function afterCycles(work: () => Promise<void>): void {
	cycleTail = cycleTail.catch(() => {}).then(work);
}

/** Resolves once every cycle and drain queued so far has finished, however it ended. */
export function cyclesSettled(): Promise<void> {
	return cycleTail.then(
		() => {},
		() => {}
	);
}

/**
 * bulkPut only new or changed rows: liveQuery fires on any write, so an idle
 * cycle would otherwise re-render every list subscriber each tick.
 */
async function putOnlyChanged<T extends { id: string }>(
	table: Table<T, string>,
	rows: T[]
): Promise<void> {
	const existing = new Map((await table.toArray()).map((r) => [r.id, r] as const));
	const changed = rows.filter((row) => {
		const prev = existing.get(row.id);
		if (!prev) return true;
		return Object.keys(row).some((k) => row[k as keyof T] !== prev[k as keyof T]);
	});
	if (changed.length > 0) await table.bulkPut(changed);
}

async function executeSyncCycle(deps: CycleDeps = {}): Promise<CycleResult> {
	const nothing = (): CycleResult => ({
		drained: 0,
		failed: 0,
		diverged: [],
		purged: [],
		mirrored: false
	});

	// Captured before the first await and asked before every write (§5.6 [D-109]).
	const session = sessionScope();
	const abandoned = () => (deps.abandoned?.() ?? false) || !session.owned();

	if (abandoned()) return nothing();

	// 1. Drain the outbox.
	const { drained, failed, error } =
		deps.push === false ? { drained: 0, failed: 0 } : await drainOutbox(deps.drain ?? {});
	if (abandoned()) return nothing();

	// 2. The digest, which carries the memberships ([D-28]). A 401 expires the
	// session and aborts the cycle before anything is purged.
	let server: DigestEntry[];
	try {
		server = await fetchServerDigest(deps.digestTransport);
	} catch (error) {
		if (isAuthRejected(error)) markAuthExpired();
		throw error;
	}
	if (abandoned()) return nothing();
	const memberships = server.map((entry) => entry.membership);
	assertMembershipData(memberships);
	const purged: string[] = [];

	// A local membership the server no longer lists is a vanished list ([D-28]);
	// this is the only path that learns it, so the §8.6 notice fires here ([D-138]).
	const localMemberships = await db.memberships.toArray();
	const serverListIds = new Set(memberships.map((m) => m.list));
	for (const local of localMemberships) {
		if (!serverListIds.has(local.list)) {
			await purgeGoneList(local.list, deps.drain?.onGone);
			purged.push(local.list);
		}
	}
	if (abandoned()) return nothing();

	// Memberships, and each list's name with them ([D-08]). Not `updated`: that
	// is the "pulled" signal ([D-185]) and waits for step 3.
	await putOnlyChanged(
		db.memberships,
		memberships.map((m) => ({
			id: m.id,
			account: m.account,
			list: m.list,
			created: m.created,
			updated: m.updated
		}))
	);
	// By id too: a list left and re-joined elsewhere has a new membership row.
	const serverIds = new Set(memberships.map((m) => m.id));
	const stale = localMemberships.filter((m) => !serverIds.has(m.id) && serverListIds.has(m.list));
	if (stale.length > 0) await db.memberships.bulkDelete(stale.map((m) => m.id));
	if (abandoned()) return nothing();
	const known = new Map((await db.lists.toArray()).map((l) => [l.id, l] as const));
	await putOnlyChanged(
		db.lists,
		server.map((d) => ({ ...known.get(d.list_id), id: d.list_id, name: d.name }))
	);
	// The home tells "not pulled yet" from "no lists" by this stamp ([D-182]), so
	// it is written before the slow steps below.
	if (abandoned()) return nothing();
	await setMeta('memberships_synced_at', new Date().toISOString());

	// 3. Reconcile diverged lists: the delta and the id set first, the full
	// snapshot when they do not explain the divergence ([D-40]).
	const local = await localDigests();
	const { diverged } = computeDivergence(local, server);
	if (abandoned()) return nothing();
	await reconcileDivergedLists(
		{ diverged, server, local },
		deps.snapshotFetcher,
		deps.snapshotIdsFetcher
	);
	if (abandoned()) return nothing();

	// Every list is pulled: its `updated` (the digest's max_updated, §9.3's sort
	// key) tells the home its count is real ([D-185]).
	await putOnlyChanged(
		db.lists,
		server.map((d) => ({ id: d.list_id, name: d.name, updated: d.max_updated }))
	);

	// 4. The reference mirror, once per session and after the pull: on a fresh
	// device it is the slowest step, and the lists must not wait for it. A
	// failure is retried next cycle and never aborts this one.
	let mirrored = false;
	if (!referenceMirrorChecked) {
		try {
			mirrored = await checkAndMirrorReference(deps.mirror ?? {});
			referenceMirrorChecked = true;
		} catch {
			/* retried next cycle */
		}
	}

	// 5. Stamp.
	if (abandoned()) return nothing();
	await setMeta('last_synced_at', new Date().toISOString());

	return { drained, failed, diverged, purged, mirrored, error };
}
