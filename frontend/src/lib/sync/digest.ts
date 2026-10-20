// The digest probe (§8.5 [D-40]).
// A library, not crypto.subtle: the browser has that only in a secure context,
// and the demo also runs on plain http:// at a LAN address ([D-335]).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { db } from '../db';
import type { DigestEntry } from './types';
import { apiJson } from './http';

export interface Digest {
	row_count: number;
	max_updated: string;
	hash: string;
}

/**
 * SHA-256 hex over the sorted `{id}:{updated}` pairs joined with "\n", plus
 * row_count and the greatest `updated` (§8.5). Byte-identical to `digestOf` in
 * backend/internal/sync/digest.go, both pinned by `seed/digest-vectors.json`.
 */
export function digestOf(rows: { id: string; updated: string }[]): Digest {
	const pairs = rows.map((r) => `${r.id}:${r.updated}`).sort();
	let max_updated = '';
	for (const r of rows) if (r.updated > max_updated) max_updated = r.updated;
	return {
		row_count: rows.length,
		max_updated,
		hash: bytesToHex(sha256(utf8ToBytes(pairs.join('\n'))))
	};
}

// One list's digest over its shadow rows, the server state as this device heard
// it: a mismatch means a missed server change. An unknown shadow ([D-40])
// mismatches on purpose.
export async function localDigest(listId: string): Promise<Digest> {
	const [items, cats] = await Promise.all([
		db.server_items.where('list').equals(listId).toArray(),
		db.server_list_categories.where('list').equals(listId).toArray()
	]);
	return digestOf([...items, ...cats].map((r) => ({ id: r.id, updated: r.updated })));
}

// Local digests by list_id, computed in parallel.
export async function localDigests(): Promise<Map<string, Digest>> {
	const memberships = await db.memberships.toArray();
	const listIds = [...new Set(memberships.map((m) => m.list))];
	const entries = await Promise.all(
		listIds.map(async (listId) => [listId, await localDigest(listId)] as const)
	);
	return new Map(entries);
}

export type DigestTransport = () => Promise<DigestEntry[]>;

async function defaultDigestTransport(): Promise<DigestEntry[]> {
	// A 401 (RequireAuth) throws with its status, which the cycle reads to tell
	// a rejected token from a transient failure.
	return (await apiJson('/api/sync/digest', {
		label: 'sync/digest',
		timeoutMs: 10_000
	})) as DigestEntry[];
}

export interface DivergenceResult {
	diverged: string[]; // list_ids needing a snapshot pull (hash mismatch, or server-only)
}

// A mismatch, or a server list unknown locally, is diverged. A local list the
// server no longer returns is the purge's business (cycle.ts, [D-28]).
export function computeDivergence(
	local: Map<string, Digest>,
	server: DigestEntry[]
): DivergenceResult {
	const serverById = new Map(server.map((d) => [d.list_id, d]));
	const diverged: string[] = [];

	for (const [listId, loc] of local) {
		const srv = serverById.get(listId);
		if (srv && srv.hash !== loc.hash) diverged.push(listId);
	}
	// A server list never digested here is pulled, not skipped.
	for (const srv of server) {
		if (!local.has(srv.list_id)) diverged.push(srv.list_id);
	}
	return { diverged };
}

// The server digest, fetched before the local ones: the purge runs on its
// membership set first ([D-28]).
export function fetchServerDigest(
	transport: DigestTransport = defaultDigestTransport
): Promise<DigestEntry[]> {
	return transport();
}
