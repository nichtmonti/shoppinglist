// Tests for the DIGEST PROBE (consistency layer) of the shoppinglist sync engine.
// Tests run under fake-indexeddb (global via src/lib/test-kit/setup.ts).
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import type { PendingOp } from '../db';
import { localDigest, localDigests, computeDivergence, digestOf } from './digest';
import { readFileSync } from 'node:fs';
import type { DigestEntry } from './types';
import { putSynced, resetDb } from '#lib/test-kit/db.js';

// A digest entry carries the caller's own membership row ([D-28]); these
// suites exercise the digest/delta mechanics, so any well-formed row will do.
const membershipFor = (list: string) => ({
	id: `mem-${list}`,
	account: 'acc1',
	list,
	created: '2025-07-26T00:00:00.000Z',
	updated: '2025-07-26T00:00:00.000Z'
});

// Helper to compute reference hash (same algorithm as localDigest but manual).
async function refHash(pairs: string[]): Promise<string> {
	const sorted = pairs.sort(); // lexicographic ascending
	const joined = sorted.join('\n');
	const data = new TextEncoder().encode(joined);
	const buf = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('localDigest', () => {
	beforeEach(async () => {
		await resetDb(); // the shadows included
		// Clear all relevant tables
		await db.items.clear();
		await db.list_categories.clear();
		await db.memberships.clear();
		await db.pending_ops.clear();
	});

	it("empty list → row_count 0, max_updated '', hash == sha256('')", async () => {
		const digest = await localDigest('list-1');
		expect(digest.row_count).toBe(0);
		expect(digest.max_updated).toBe('');
		const emptyHash = await refHash([]);
		expect(digest.hash).toBe(emptyHash);
	});

	it('over 2 items + 1 category → row_count 3, hash matches reference, max_updated is largest', async () => {
		const listId = 'list-1';
		await putSynced([
			{
				id: 'item-1',
				list: listId,
				name: 'Milk',
				quantity: '1',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T10:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			},
			{
				id: 'item-2',
				list: listId,
				name: 'Bread',
				quantity: '2',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T11:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			}
		]);
		await putSynced(
			[],
			[
				{
					id: 'cat-1',
					list: listId,
					slug: 'dairy',
					name: 'Dairy',
					icon: '🥛',
					color: '#ffffff',
					sort_order: 1,
					updated: '2025-07-26T12:00:00.000Z',
					created: '2025-07-26T09:00:00.000Z',
					deleted_at: null
				}
			]
		);

		const digest = await localDigest(listId);
		expect(digest.row_count).toBe(3);
		expect(digest.max_updated).toBe('2025-07-26T12:00:00.000Z');

		const pairs = [
			'cat-1:2025-07-26T12:00:00.000Z',
			'item-1:2025-07-26T10:00:00.000Z',
			'item-2:2025-07-26T11:00:00.000Z'
		];
		const expectedHash = await refHash(pairs);
		expect(digest.hash).toBe(expectedHash);
	});

	it('counts only server rows: a queued create has no shadow, so it is not in it', async () => {
		const listId = 'list-1';
		const item1Id = 'item-1';
		const item2Id = 'item-2';

		// item-1 exists only here (its create is queued), item-2 is synced.
		await db.items.bulkPut([
			{
				id: item1Id,
				list: listId,
				name: 'Milk',
				quantity: '1',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T10:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			},
			{
				id: item2Id,
				list: listId,
				name: 'Bread',
				quantity: '2',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T11:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			}
		]);

		await db.server_items.put((await db.items.get(item2Id))!);

		// Add a pending CREATE op for item-1
		const createOp: PendingOp = {
			op_id: crypto.randomUUID(),
			collection: 'items',
			record_id: item1Id,
			list_id: listId,
			type: 'create',
			changed: { name: 'Milk' },
			base: {},
			queued_at: new Date().toISOString()
		};
		await db.pending_ops.add(createOp);

		const digest = await localDigest(listId);
		expect(digest.row_count).toBe(1); // only item-2: the server does not have item-1 yet

		const pairs = ['item-2:2025-07-26T11:00:00.000Z'];
		const expectedHash = await refHash(pairs);
		expect(digest.hash).toBe(expectedHash);
	});

	it('INCLUDES rows with a pending UPDATE op', async () => {
		const listId = 'list-1';
		const itemId = 'item-1';

		await putSynced([
			{
				id: itemId,
				list: listId,
				name: 'Milk',
				quantity: '1',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T10:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			}
		]);

		// Add a pending UPDATE op
		const updateOp: PendingOp = {
			op_id: crypto.randomUUID(),
			collection: 'items',
			record_id: itemId,
			list_id: listId,
			type: 'update',
			changed: { quantity: '2' },
			base: { quantity: '1' },
			queued_at: new Date().toISOString()
		};
		await db.pending_ops.add(updateOp);

		const digest = await localDigest(listId);
		expect(digest.row_count).toBe(1); // Row is still included

		const pairs = ['item-1:2025-07-26T10:00:00.000Z'];
		const expectedHash = await refHash(pairs);
		expect(digest.hash).toBe(expectedHash);
	});

	it('INCLUDES tombstoned rows (deleted_at set)', async () => {
		const listId = 'list-1';

		await putSynced([
			{
				id: 'item-1',
				list: listId,
				name: 'Milk',
				quantity: '1',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T10:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: '2025-07-26T11:00:00.000Z' // Tombstoned
			}
		]);

		const digest = await localDigest(listId);
		expect(digest.row_count).toBe(1); // Tombstoned row is included

		const pairs = ['item-1:2025-07-26T10:00:00.000Z'];
		const expectedHash = await refHash(pairs);
		expect(digest.hash).toBe(expectedHash);
	});
});

describe('localDigests', () => {
	beforeEach(async () => {
		await resetDb(); // the shadows included
		await db.items.clear();
		await db.list_categories.clear();
		await db.memberships.clear();
		await db.pending_ops.clear();
	});

	it('returns one entry per local membership', async () => {
		// Create 2 memberships on different lists
		await db.memberships.bulkPut([
			{
				id: 'mem-1',
				account: 'account-1',
				list: 'list-1',
				created: '2025-07-26T09:00:00.000Z',
				updated: '2025-07-26T09:00:00.000Z'
			},
			{
				id: 'mem-2',
				account: 'account-1',
				list: 'list-2',
				created: '2025-07-26T09:00:00.000Z',
				updated: '2025-07-26T09:00:00.000Z'
			}
		]);

		// Add a row in each list
		await putSynced([
			{
				id: 'item-1',
				list: 'list-1',
				name: 'Milk',
				quantity: '1',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T10:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			},
			{
				id: 'item-2',
				list: 'list-2',
				name: 'Bread',
				quantity: '2',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				name_de: null,
				name_en: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2025-07-26T11:00:00.000Z',
				created: '2025-07-26T09:00:00.000Z',
				deleted_at: null
			}
		]);

		const digests = await localDigests();
		expect(digests.size).toBe(2);
		expect(digests.has('list-1')).toBe(true);
		expect(digests.has('list-2')).toBe(true);

		// Verify list-1 digest
		const list1Digest = digests.get('list-1');
		expect(list1Digest?.row_count).toBe(1);
		expect(list1Digest?.max_updated).toBe('2025-07-26T10:00:00.000Z');

		// Verify list-2 digest
		const list2Digest = digests.get('list-2');
		expect(list2Digest?.row_count).toBe(1);
		expect(list2Digest?.max_updated).toBe('2025-07-26T11:00:00.000Z');
	});
});

describe('computeDivergence', () => {
	it('matching hash → not diverged; mismatching hash → diverged; server-only list → diverged; local-only list → left alone', async () => {
		// Build local digests for 3 lists
		const local = new Map<string, { row_count: number; max_updated: string; hash: string }>();

		// list-1: matching hash with server
		local.set('list-1', { row_count: 1, max_updated: '2025-07-26T10:00:00.000Z', hash: 'hash-1' });

		// list-2: mismatching hash with server
		local.set('list-2', {
			row_count: 1,
			max_updated: '2025-07-26T11:00:00.000Z',
			hash: 'hash-local-2'
		});

		// list-3: local-only (not in server)
		local.set('list-3', { row_count: 1, max_updated: '2025-07-26T12:00:00.000Z', hash: 'hash-3' });

		// Server digests: list-1 (match), list-2 (different hash), list-4 (server-only)
		const server: DigestEntry[] = [
			{
				list_id: 'list-1',
				row_count: 1,
				max_updated: '2025-07-26T10:00:00.000Z',
				hash: 'hash-1',
				name: 'List',
				membership: membershipFor('list-1')
			},
			{
				list_id: 'list-2',
				row_count: 1,
				max_updated: '2025-07-26T11:00:00.000Z',
				hash: 'hash-server-2',
				name: 'List',
				membership: membershipFor('list-2')
			},
			{
				list_id: 'list-4',
				row_count: 1,
				max_updated: '2025-07-26T13:00:00.000Z',
				hash: 'hash-4',
				name: 'List',
				membership: membershipFor('list-4')
			}
		];

		const result = computeDivergence(local, server);

		// Diverged: list-2 (hash mismatch), list-4 (server-only)
		expect(result.diverged.sort()).toEqual(['list-2', 'list-4']);

		// list-3 is local-only. The digest deliberately says NOTHING about it:
		// the digest's membership set (cycle.ts, [D-28]) is the sole vanished-list
		// detector, so pulling a snapshot here would just fail against a list the
		// caller is no longer a member of.
		expect(result.diverged).not.toContain('list-3');
	});
});

describe('shared digest vectors (Go ↔ TypeScript agreement)', () => {
	// The same fixture the Go suite reads (backend/internal/sync/digest_test.go), in the spirit
	// of the [D-44] normalization vectors. The two digest implementations must agree byte for
	// byte: if they drift, every list reads as permanently diverged and the client pulls a full
	// snapshot every cycle — silent and expensive, and invisible to a single-language test.
	interface Vector {
		note: string;
		rows: { id: string; updated: string }[];
		row_count: number;
		max_updated: string;
		hash: string;
	}
	const vectors = JSON.parse(
		readFileSync(new URL('../../../../backend/seed/digest-vectors.json', import.meta.url), 'utf-8')
	) as Vector[];

	it('has vectors', () => {
		expect(vectors.length).toBeGreaterThan(0);
	});

	for (const v of vectors) {
		it(`matches the fixture: ${v.note}`, async () => {
			const d = digestOf(v.rows);
			expect(d.hash).toBe(v.hash);
			expect(d.row_count).toBe(v.row_count);
			expect(d.max_updated).toBe(v.max_updated);
		});
	}
});
