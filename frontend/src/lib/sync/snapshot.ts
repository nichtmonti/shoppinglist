import { reportUncaught } from '#lib/client-errors.js';
import { allCollectionTables, db, shadowTable, syncTable } from '../db';
import type { SyncCollection } from './types';
import { applyServerRows, forgetServerRows } from './apply';
import { localDigest, type Digest } from './digest';
import type { DigestEntry } from './types';
import { apiJson } from './http';
import { sessionScope, type SessionScope } from '../auth/session';

/** A list's rows as the server sent them; applyServerRows normalizes them. */
export interface SnapshotRows {
	items: object[];
	categories: object[];
}

export type SnapshotFetcher = (listId: string, since?: string) => Promise<SnapshotRows>;

/** A list's ids, tombstones included: the server's row set without the rows. */
export interface SnapshotIds {
	items: string[];
	categories: string[];
}

export type SnapshotIdsFetcher = (listId: string) => Promise<SnapshotIds>;

// GET /api/sync/snapshot/{listId} ([D-173]); `?since=` asks for the delta,
// `?ids` for the id set ([D-40]). Not the collection API, which answers a lost
// list or a rejected token with an empty 200 the sweep would read as "empty
// list"; this route answers 401/403.
async function getSnapshot(listId: string, query: string, what: string) {
	const body = (await apiJson(`/api/sync/snapshot/${encodeURIComponent(listId)}${query}`, {
		label: 'sync/snapshot',
		timeoutMs: 10_000
	})) as { items?: unknown; categories?: unknown };
	if (!Array.isArray(body.items) || !Array.isArray(body.categories)) {
		throw new Error(`sync/snapshot: response is not ${what}`);
	}
	return { items: body.items as unknown[], categories: body.categories as unknown[] };
}

async function defaultFetcher(listId: string, since?: string): Promise<SnapshotRows> {
	const query = since ? `?since=${encodeURIComponent(since)}` : '';
	return (await getSnapshot(listId, query, 'a snapshot')) as SnapshotRows;
}

async function defaultIdsFetcher(listId: string): Promise<SnapshotIds> {
	const body = await getSnapshot(listId, '?ids', 'an id set');
	if (![...body.items, ...body.categories].every((id) => typeof id === 'string')) {
		throw new Error('sync/snapshot: response is not an id set');
	}
	return body as SnapshotIds;
}

// One list's full snapshot, reconciled in one transaction that also reads the
// queued ops ([D-40]); the session is asked inside it (§5.6 [D-109]).
export async function reconcileList(
	listId: string,
	fetcher: SnapshotFetcher = defaultFetcher,
	session: SessionScope = sessionScope()
): Promise<void> {
	const snap = await fetcher(listId);
	await db.transaction('rw', allCollectionTables(), async () => {
		if (!session.owned()) return;
		await reconcileCollection('items', listId, snap.items);
		await reconcileCollection('list_categories', listId, snap.categories);
	});
}

// One collection against the full server set: server rows become shadows, the
// rest go (forgetAbsent). Runs inside the caller's transaction.
async function reconcileCollection(
	collection: SyncCollection,
	listId: string,
	serverRows: object[]
): Promise<void> {
	await forgetAbsent(collection, listId, new Set(await applyServerRows(collection, serverRows)));
}

// The list's shadows and rows whose ids the server no longer has go, and the
// view follows (apply.ts): a queued create stays, a queued update loses its
// row and stays queued for its push to answer. Runs inside the caller's
// transaction.
async function forgetAbsent(
	collection: SyncCollection,
	listId: string,
	serverIds: Set<string>
): Promise<void> {
	const [shadowIds, viewIds] = await Promise.all([
		shadowTable(collection).where('list').equals(listId).primaryKeys(),
		syncTable(collection).where('list').equals(listId).primaryKeys()
	]);
	await forgetServerRows(
		collection,
		[...shadowIds, ...viewIds].filter((id) => !serverIds.has(id))
	);
}

// The [D-40] id repair: only what the server dropped (swept tombstones, admin
// deletes) goes; every other row is left as it is.
async function forgetVanished(
	listId: string,
	idsFetcher: SnapshotIdsFetcher,
	session: SessionScope
): Promise<void> {
	const ids = await idsFetcher(listId);
	await db.transaction('rw', allCollectionTables(), async () => {
		if (!session.owned()) return; // see reconcileList
		await forgetAbsent('items', listId, new Set(ids.items));
		await forgetAbsent('list_categories', listId, new Set(ids.categories));
	});
}

// The [D-40] delta: upsert only, since absence means nothing.
async function applyDelta(
	listId: string,
	since: string,
	fetcher: SnapshotFetcher,
	session: SessionScope
): Promise<void> {
	const snap = await fetcher(listId, since);
	await db.transaction('rw', allCollectionTables(), async () => {
		if (!session.owned()) return; // see reconcileList
		await applyServerRows('items', snap.items);
		await applyServerRows('list_categories', snap.categories);
	});
}

export interface DivergenceInput {
	diverged: string[];
	server: DigestEntry[];
	local: Map<string, Digest>;
}

// Reconcile the diverged lists ([D-40]), cheapest first, re-digesting after
// each step: the delta when the server is newer, then the id set, which drops
// what the server hard-deleted; the full snapshot only for what neither
// explains (same-millisecond stamps, a shadow of unknown state). A fresh
// join's empty `since` fetches everything.
export async function reconcileDivergedLists(
	input: DivergenceInput,
	fetcher: SnapshotFetcher = defaultFetcher,
	idsFetcher: SnapshotIdsFetcher = defaultIdsFetcher
): Promise<void> {
	// Captured once for the whole pass (§5.6 [D-109]).
	const session = sessionScope();
	const serverById = new Map(input.server.map((d) => [d.list_id, d]));
	for (const listId of input.diverged) {
		if (!session.owned()) return;
		const srv = serverById.get(listId);
		const loc = input.local.get(listId);
		if (srv && loc) {
			const converged = async () => (await localDigest(listId)).hash === srv.hash;
			if (srv.max_updated > loc.max_updated) {
				await applyDelta(listId, loc.max_updated, fetcher, session);
				if (!session.owned()) return;
				if (await converged()) continue;
			}
			await forgetVanished(listId, idsFetcher, session);
			if (!session.owned()) return;
			if (await converged()) continue;
		}
		await reconcileList(listId, fetcher, session);
		if (srv && session.owned()) verifyConverged(listId, srv, await localDigest(listId));
	}
}

// After the full snapshot, a still-mismatched digest means the mirror is wrong:
// report it to the server log ([D-197]), do not throw. Local ahead (an SSE
// event since the probe) is excluded.
function verifyConverged(listId: string, srv: DigestEntry, after: Digest): void {
	if (after.hash !== srv.hash && after.max_updated <= srv.max_updated) {
		const error = new Error(
			`reconcile failed to converge list ${listId}: ` +
				`server rows=${srv.row_count} max=${srv.max_updated} vs ` +
				`local rows=${after.row_count} max=${after.max_updated}`
		);
		console.error(`[sync] ${error.message}`);
		reportUncaught(error, 'sync');
	}
}
