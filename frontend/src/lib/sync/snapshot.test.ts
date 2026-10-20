import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, type Item, type PendingOp } from '../db';
import {
	reconcileList,
	reconcileDivergedLists,
	type SnapshotFetcher,
	type SnapshotIdsFetcher
} from './snapshot';
import { digestOf, localDigest, type Digest } from './digest';
import type { DigestEntry } from './types';

import { createRecord, deleteRecord, updateRecord } from './outbox';
import { putSynced, queueOp, resetDb } from '#lib/test-kit/db.js';
import { endSession, resetSessionForTest } from '#lib/auth/session.js';

// A digest entry carries the caller's own membership row ([D-28]); these
// suites exercise the digest/delta mechanics, so any well-formed row will do.
const membershipFor = (list: string) => ({
	id: `mem-${list}`,
	account: 'acc1',
	list,
	created: '2025-07-26T00:00:00.000Z',
	updated: '2025-07-26T00:00:00.000Z'
});

describe('snapshot.ts', () => {
	beforeEach(async () => {
		await resetDb(); // every table, the shadows included
		await db.items.clear();
		await db.list_categories.clear();
		await db.pending_ops.clear();
	});

	afterEach(async () => {
		await db.items.clear();
		await db.list_categories.clear();
		await db.pending_ops.clear();
	});

	function seedItem(overrides: Partial<Item> = {}): Item {
		return {
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
			updated: '2024-01-01T00:00:00.000Z',
			created: '2024-01-01T00:00:00.000Z',
			deleted_at: null,
			...overrides
		};
	}

	// [D-173] The default fetcher reads the authenticated snapshot route. The full
	// snapshot's sweep drops local rows the server did not return, so a refusal or
	// a body that is not a snapshot must throw BEFORE the sweep — never read as
	// "the list is empty".
	describe('default fetcher (GET /api/sync/snapshot)', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});
		const respond = (status: number, body: unknown) =>
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(body), {
					status,
					headers: { 'Content-Type': 'application/json' }
				})
			);

		it.each([401, 403])(
			'a %i throws with its status and leaves local rows alone',
			async (status) => {
				await putSynced([seedItem()]);
				vi.stubGlobal('fetch', respond(status, { message: 'no' }));

				await expect(reconcileList('list-1')).rejects.toMatchObject({ status });
				expect(await db.items.get('item-1')).toBeDefined();
			}
		);

		it('a body that is not a snapshot throws and leaves local rows alone', async () => {
			await putSynced([seedItem()]);
			vi.stubGlobal('fetch', respond(200, '<!doctype html>'));

			await expect(reconcileList('list-1')).rejects.toThrow('not a snapshot');
			expect(await db.items.get('item-1')).toBeDefined();
		});

		it('an empty snapshot is authoritative: the sweep runs', async () => {
			await putSynced([seedItem()]);
			const fetch = respond(200, { items: [], categories: [] });
			vi.stubGlobal('fetch', fetch);

			await reconcileList('list-1');
			expect(await db.items.get('item-1')).toBeUndefined();
			expect(fetch.mock.calls[0][0]).toBe('/api/sync/snapshot/list-1');
		});

		const divergedOnce = async (ids: SnapshotIdsFetcher | undefined, fetcher: SnapshotFetcher) =>
			reconcileDivergedLists(
				{
					diverged: ['list-1'],
					server: [
						{
							...(await digestOf([])),
							list_id: 'list-1',
							name: 'List',
							membership: membershipFor('list-1')
						}
					],
					local: new Map([['list-1', await localDigest('list-1')]])
				},
				fetcher,
				ids
			);

		it('the id set is asked with ?ids, and an empty one drops every row', async () => {
			await putSynced([seedItem()]);
			const fetch = respond(200, { items: [], categories: [] });
			vi.stubGlobal('fetch', fetch);
			const fetcher = vi.fn<SnapshotFetcher>();

			await divergedOnce(undefined, fetcher);
			expect(fetch.mock.calls[0][0]).toBe('/api/sync/snapshot/list-1?ids');
			expect(await db.items.get('item-1')).toBeUndefined();
			expect(fetcher).not.toHaveBeenCalled();
		});

		it('a body that is not an id set throws and leaves local rows alone', async () => {
			await putSynced([seedItem()]);
			vi.stubGlobal('fetch', respond(200, { items: [{ id: 'item-1' }], categories: [] }));

			await expect(divergedOnce(undefined, vi.fn<SnapshotFetcher>())).rejects.toThrow(
				'not an id set'
			);
			expect(await db.items.get('item-1')).toBeDefined();
		});
	});

	describe('upserts server rows', () => {
		it('replaces stale local item with server version', async () => {
			// Seed local with stale item
			const staleItem = seedItem({ id: 'item-a', quantity: '1' });
			await putSynced([staleItem]);

			// Fetcher returns updated item
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', quantity: '2', updated: '2024-01-02T00:00:00.000Z' })],
				categories: []
			});

			await reconcileList('list-1', fetcher);

			const result = await db.items.get('item-a');
			expect(result?.quantity).toBe('2');
			expect(result?.updated).toBe('2024-01-02T00:00:00.000Z');
		});

		it('adds new server item', async () => {
			// Seed local with item A
			await putSynced([seedItem({ id: 'item-a' })]);

			// Fetcher returns A + new B
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a' }), seedItem({ id: 'item-b', name: 'Bread' })],
				categories: []
			});

			await reconcileList('list-1', fetcher);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(2);
			const b = items.find((i) => i.id === 'item-b');
			expect(b?.name).toBe('Bread');
		});
	});

	describe('drops local rows the server no longer has', () => {
		it('deletes local item B when server only has A (no pending op)', async () => {
			// Seed local with A and B
			await putSynced([seedItem({ id: 'item-a', name: 'A' })]);
			await putSynced([seedItem({ id: 'item-b', name: 'B' })]);

			// Fetcher returns only A
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', name: 'A' })],
				categories: []
			});

			await reconcileList('list-1', fetcher);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(1);
			expect(items[0].id).toBe('item-a');
		});
	});

	describe('rows the server does not list', () => {
		it('keeps a row with a queued create — the server cannot list what it has not been sent', async () => {
			await putSynced([seedItem({ id: 'item-a', name: 'A' })]);
			await createRecord('items', 'list-1', 'item-b', { name: 'B' });

			await reconcileList('list-1', async () => ({
				items: [seedItem({ id: 'item-a', name: 'A' })],
				categories: []
			}));

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items.map((i) => i.id).sort()).toEqual(['item-a', 'item-b']);
			expect((await db.items.get('item-b'))?.name).toBe('B');
		});

		it('drops a row the server no longer has, queued update or not — its push answers for the edit', async () => {
			// docs/internals/design.md §8.5: the shadow goes, and a row is its
			// shadow with the op on top. The push of the edit comes back `row_missing`
			// (a denial the user is told about) or `gone` with the list.
			await putSynced([seedItem({ id: 'item-a', name: 'A' })]);
			await putSynced([seedItem({ id: 'item-b', name: 'B' })]);
			await queueOp({
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-b',
				list_id: 'list-1',
				type: 'update',
				changed: { quantity: '5' },
				base: { quantity: '1' },
				queued_at: new Date().toISOString()
			});

			await reconcileList('list-1', async () => ({
				items: [seedItem({ id: 'item-a', name: 'A' })],
				categories: []
			}));

			expect((await db.items.where('list').equals('list-1').toArray()).map((i) => i.id)).toEqual([
				'item-a'
			]);
			expect(await db.pending_ops.count()).toBe(1); // still queued, for the push to settle
		});
	});

	describe("field-level guard: a pending op's changed fields are preserved over the inbound server value", () => {
		it('keeps local quantity 9 (pending) when server has quantity 2', async () => {
			// Seed local A with optimistic quantity 9
			const localA = seedItem({ id: 'item-a', quantity: '9' });
			await putSynced([localA]);

			// Add pending op for A with changed quantity
			const pendingOp: PendingOp = {
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-a',
				list_id: 'list-1',
				type: 'update',
				changed: { quantity: '9' },
				base: { quantity: '1' },
				queued_at: new Date().toISOString()
			};
			await queueOp(pendingOp);

			// Fetcher returns A with server quantity 2
			const fetcher: SnapshotFetcher = async () => ({
				items: [
					seedItem({
						id: 'item-a',
						quantity: '2',
						name: 'Server Name',
						updated: '2024-01-02T00:00:00.000Z'
					})
				],
				categories: []
			});

			await reconcileList('list-1', fetcher);

			const result = await db.items.get('item-a');
			expect(result?.quantity).toBe('9'); // Guarded field stays local
			expect(result?.name).toBe('Server Name'); // Non-changed field takes server value
			expect(result?.updated).toBe('2024-01-02T00:00:00.000Z'); // Non-changed field
		});
	});

	describe('tombstoned server rows are upserted', () => {
		it('keeps item with deleted_at set', async () => {
			// No local items
			// Fetcher returns tombstoned item
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', deleted_at: '2024-01-02T00:00:00.000Z' })],
				categories: []
			});

			await reconcileList('list-1', fetcher);

			const result = await db.items.get('item-a');
			expect(result?.deleted_at).toBe('2024-01-02T00:00:00.000Z');
		});
	});

	describe('reconciles both items AND list_categories', () => {
		it('handles both collections in one reconcile', async () => {
			// Seed local items and categories
			await putSynced([seedItem({ id: 'item-a' })]);
			await db.list_categories.put({
				id: 'cat-a',
				list: 'list-1',
				slug: 'dairy',
				name: 'Dairy',
				icon: '🥛',
				color: '#ffffff',
				sort_order: 1,
				updated: '2024-01-01T00:00:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			});

			// Fetcher returns updated versions
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', name: 'Updated Item' })],
				categories: [
					{
						id: 'cat-a',
						list: 'list-1',
						slug: 'dairy',
						name: 'Updated Dairy',
						icon: '🥛',
						color: '#ffff00',
						sort_order: 1,
						updated: '2024-01-02T00:00:00.000Z',
						created: '2024-01-01T00:00:00.000Z',
						deleted_at: null
					}
				]
			});

			await reconcileList('list-1', fetcher);

			const item = await db.items.get('item-a');
			const cat = await db.list_categories.get('cat-a');
			expect(item?.name).toBe('Updated Item');
			expect(cat?.name).toBe('Updated Dairy');
			expect(cat?.color).toBe('#ffff00');
		});
	});

	describe('a pending op enqueued mid-fetch is visible', () => {
		it('protects row B when its create is queued during the fetch, before the tx runs', async () => {
			await putSynced([seedItem({ id: 'item-a', name: 'A' })]);

			const fetcher: SnapshotFetcher = async () => {
				await Promise.resolve(); // the fetch is under way…
				// …when the user adds B.
				await createRecord('items', 'list-1', 'item-b', { name: 'B' });
				return { items: [seedItem({ id: 'item-a', name: 'A' })], categories: [] };
			};

			await reconcileList('list-1', fetcher);

			// B is still there: the op set is read INSIDE the tx, so an op enqueued
			// during the fetch is visible to it.
			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(2);
			expect(items.find((i) => i.id === 'item-b')?.name).toBe('B');
		});
	});
	describe("the guard covers a pending field's server-stamped companions", () => {
		it('an offline delete survives a snapshot that still shows the row alive', async () => {
			const row = seedItem({ id: 'item-A' });
			await putSynced([row]);
			await deleteRecord('items', row);

			// The server has not seen the delete yet: the snapshot row is still alive.
			await reconcileList(row.list, async () => ({
				items: [{ ...row, deleted_at: null, updated: 'srv-2' }],
				categories: []
			}));

			const after = await db.items.get(row.id);
			// deleted_at must stay set, or the deleted item pops back into the UI.
			expect(after!.deleted_at).not.toBeNull();
			expect(after!.updated).toBe('srv-2'); // unguarded fields still take the server value
		});

		it('an offline check-off keeps its local checked_at', async () => {
			const row = seedItem({ id: 'item-B' });
			await putSynced([row]);
			// The optimistic stamp rides in rowOnly, as setChecked passes it.
			await updateRecord(
				'items',
				row,
				{ checked: true },
				{
					stamps: {
						checked_at: '2026-05-05T00:00:00.000Z'
					}
				}
			);

			await reconcileList(row.list, async () => ({
				items: [{ ...row, checked: false, checked_at: null, updated: 'srv-2' }],
				categories: []
			}));

			const after = await db.items.get(row.id);
			expect(after!.checked).toBe(true);
			// A checked row with a null checked_at would fall out of the §9.1 recently-checked section.
			expect(after!.checked_at).toBe('2026-05-05T00:00:00.000Z');
		});
	});

	describe('reconcileDivergedLists ([D-40] timestamp delta)', () => {
		// Build the server-side digest entry for a list from the rows the server holds.
		async function serverEntry(rows: { id: string; updated: string }[]): Promise<DigestEntry> {
			const d: Digest = await digestOf(rows);
			return {
				list_id: 'list-1',
				row_count: d.row_count,
				max_updated: d.max_updated,
				hash: d.hash,
				name: 'List',
				membership: membershipFor('list-1')
			};
		}

		async function localDigests(): Promise<Map<string, Digest>> {
			return new Map([['list-1', await localDigest('list-1')]]);
		}

		it('pulls only rows changed since the local max, then verifies and stops', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't1' })]);

			// Server: b changed, c added, one category changed — all after the local max t1.
			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-b', updated: 't2' },
				{ id: 'item-c', updated: 't3' },
				{ id: 'cat-x', updated: 't2' }
			]);

			const fetcher = vi.fn(async (_id: string, since?: string) => {
				expect(since).toBe('t1');
				return {
					items: [
						seedItem({ id: 'item-b', updated: 't2' }),
						seedItem({ id: 'item-c', updated: 't3' })
					],
					categories: [
						{
							id: 'cat-x',
							list: 'list-1',
							slug: 'dairy',
							name: 'Dairy',
							icon: '🥛',
							color: '#ffffff',
							sort_order: 1,
							updated: 't2',
							created: 't1',
							deleted_at: null
						}
					]
				};
			});

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher
			);

			// All rows present, fetcher called ONCE (verify passed — no full pull).
			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(3);
			const cat = await db.list_categories.get('cat-x');
			expect(cat?.name).toBe('Dairy');
			expect(fetcher).toHaveBeenCalledTimes(1);
		});

		it('delta is upsert-only: rows absent from the delta survive', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't1' })]);

			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-b', updated: 't1' },
				{ id: 'item-c', updated: 't2' }
			]);

			// Delta returns ONLY the new row — the full set is never fetched.
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-c', updated: 't2' })],
				categories: []
			});

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher
			);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(3); // a and b survive, c added
		});

		it('a delta that leaves a hard-deleted row is repaired by the id set, not the full snapshot', async () => {
			// b is a tombstone the server hard-deleted (GC/admin) — invisible to any delta.
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't1' })]);

			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-c', updated: 't2' }
			]);

			const fetcher = vi.fn(async (_id: string, since?: string) => {
				expect(since).toBe('t1'); // the delta only, never the full snapshot
				return { items: [seedItem({ id: 'item-c', updated: 't2' })], categories: [] };
			});
			const idsFetcher = vi.fn<SnapshotIdsFetcher>(async () => ({
				items: ['item-a', 'item-c'],
				categories: []
			}));

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher,
				idsFetcher
			);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items.map((i) => i.id).sort()).toEqual(['item-a', 'item-c']);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(idsFetcher).toHaveBeenCalledWith('list-1');
			expect((await localDigest('list-1')).hash).toBe(server.hash);
		});

		it('server not newer and a row swept: the id set alone repairs it, a queued create stays', async () => {
			// The daily sweep's shape: a tombstone is hard-deleted, which changes
			// the server's hash but not its max_updated.
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't0', deleted_at: 't0' })]);
			await db.server_list_categories.put({
				id: 'cat-gone',
				list: 'list-1',
				slug: 'dairy',
				name: 'Dairy',
				icon: '',
				color: '',
				sort_order: 1,
				updated: 't0',
				created: 't0',
				deleted_at: 't0'
			});
			await createRecord('items', 'list-1', 'item-new', { name: 'Bread' });
			const server = await serverEntry([{ id: 'item-a', updated: 't1' }]);
			const fetcher = vi.fn<SnapshotFetcher>();
			const idsFetcher = vi.fn<SnapshotIdsFetcher>(async () => ({
				items: ['item-a'],
				categories: []
			}));

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher,
				idsFetcher
			);

			expect(fetcher).not.toHaveBeenCalled();
			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items.map((i) => i.id).sort()).toEqual(['item-a', 'item-new']);
			expect(await db.server_list_categories.get('cat-gone')).toBeUndefined();
			expect(await db.pending_ops.count()).toBe(1);
			expect((await localDigest('list-1')).hash).toBe(server.hash);
		});

		it('a session ended during the id fetch writes nothing (§5.6 [D-109])', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't0' })]);
			const server = await serverEntry([{ id: 'item-a', updated: 't1' }]);
			const fetcher = vi.fn<SnapshotFetcher>();
			try {
				await reconcileDivergedLists(
					{ diverged: ['list-1'], server: [server], local: await localDigests() },
					fetcher,
					async () => {
						endSession();
						return { items: ['item-a'], categories: [] };
					}
				);
			} finally {
				resetSessionForTest();
			}

			expect(await db.server_items.get('item-b')).toBeDefined();
			expect(fetcher).not.toHaveBeenCalled();
		});

		it('server max not newer and the id set explains nothing → the full snapshot, no delta', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't1' })]);

			// c exists server-side with an OLD timestamp: max_updated stays t1, but the
			// row_count/hash differ — a delta with since=t1 would be empty by construction.
			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-b', updated: 't1' },
				{ id: 'item-c', updated: 't0' }
			]);

			const fetchImpl: SnapshotFetcher = async () => ({
				items: [
					seedItem({ id: 'item-a', updated: 't1' }),
					seedItem({ id: 'item-b', updated: 't1' }),
					seedItem({ id: 'item-c', updated: 't0' })
				],
				categories: []
			});
			const fetcher = vi.fn(fetchImpl);
			const idsFetcher = vi.fn<SnapshotIdsFetcher>(async () => ({
				items: ['item-a', 'item-b', 'item-c'],
				categories: []
			}));

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher,
				idsFetcher
			);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(3);
			expect(idsFetcher).toHaveBeenCalledTimes(1);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0][1]).toBeUndefined(); // never a delta
		});

		it('server-only list (no local rows yet) → full snapshot without a since', async () => {
			const server = await serverEntry([{ id: 'item-a', updated: 't1' }]);

			const fetchImpl: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', updated: 't1' })],
				categories: []
			});
			const fetcher = vi.fn(fetchImpl);

			// local map is empty — the list only exists server-side (fresh join).
			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: new Map() },
				fetcher
			);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(1);
			expect(fetcher.mock.calls[0][1]).toBeUndefined();
		});

		it('pending-create rows do not push the since value', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);

			// A pending create with an optimistic timestamp newer than any server row.
			await putSynced([seedItem({ id: 'item-b', updated: 't9' })]);
			const pendingOp: PendingOp = {
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-b',
				list_id: 'list-1',
				type: 'create',
				changed: { name: 'Bread' },
				base: {},
				queued_at: new Date().toISOString()
			};
			await queueOp(pendingOp);

			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-c', updated: 't2' }
			]);

			const fetcher = vi.fn(async (_id: string, since?: string) => {
				expect(since).toBe('t1'); // NOT t9 — the pending create is excluded (§8.5)
				return { items: [seedItem({ id: 'item-c', updated: 't2' })], categories: [] };
			});

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher
			);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(3);
			expect(fetcher).toHaveBeenCalledTimes(1); // verify passed — no full pull
		});

		it("delta path still preserves a pending op's guarded fields", async () => {
			await putSynced([seedItem({ id: 'item-a', quantity: '9', updated: 't1' })]);
			const pendingOp: PendingOp = {
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-a',
				list_id: 'list-1',
				type: 'update',
				changed: { quantity: '9' },
				base: { quantity: '1' },
				queued_at: new Date().toISOString()
			};
			await queueOp(pendingOp);

			const server = await serverEntry([{ id: 'item-a', updated: 't2' }]);

			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', quantity: '2', name: 'Server Name', updated: 't2' })],
				categories: []
			});

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher
			);

			const result = await db.items.get('item-a');
			expect(result?.quantity).toBe('9'); // guarded field stays local
			expect(result?.name).toBe('Server Name'); // unguarded takes the server value
		});

		it('a pending op enqueued mid-delta-fetch is visible to the field guard', async () => {
			await putSynced([seedItem({ id: 'item-a', quantity: '1', updated: 't1' })]);

			const server = await serverEntry([{ id: 'item-a', updated: 't2' }]);

			// The user edits item-a DURING the delta fetch, before the upsert tx runs —
			// the same mid-fetch race the full-snapshot path pins above.
			const fetcher = vi.fn(async (_id: string, since?: string) => {
				expect(since).toBe('t1');
				await Promise.resolve(); // simulate async work (the fetch)
				await updateRecord('items', seedItem({ id: 'item-a', quantity: '1', updated: 't1' }), {
					quantity: '9'
				});
				return {
					items: [seedItem({ id: 'item-a', quantity: '2', name: 'Server Name', updated: 't2' })],
					categories: []
				};
			});

			await reconcileDivergedLists(
				{ diverged: ['list-1'], server: [server], local: await localDigests() },
				fetcher
			);

			// the op set is read inside the delta tx, so the mid-fetch op guards its field...
			const result = await db.items.get('item-a');
			expect(result?.quantity).toBe('9');
			expect(result?.name).toBe('Server Name');
			// ...and `updated` staying at the server value keeps the verify digest matching —
			// no spurious full-snapshot fallback.
			expect(result?.updated).toBe('t2');
			expect(fetcher).toHaveBeenCalledTimes(1);
		});

		it('empty local digest (fresh join / wiped DB) degrades to a full pull via since=""', async () => {
			// [D-40]: a list with a membership but no local rows has an EMPTY digest
			// (max_updated ""), so the delta branch fires with since "" — which the default
			// fetcher treats as no filter (a full pull), and the verify passes. This is the
			// real fresh-join wiring: step 2 of the cycle writes the membership before the
			// probe, so `local` contains the list with an empty digest — not "no entry".
			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-b', updated: 't2' }
			]);

			const fetcher = vi.fn(async (_id: string, since?: string) => {
				expect(since).toBe(''); // documented degradation, not a full-snapshot detour
				return {
					items: [
						seedItem({ id: 'item-a', updated: 't1' }),
						seedItem({ id: 'item-b', updated: 't2' })
					],
					categories: []
				};
			});

			await reconcileDivergedLists(
				{
					diverged: ['list-1'],
					server: [server],
					local: new Map([['list-1', await digestOf([])]])
				},
				fetcher
			);

			const items = await db.items.where('list').equals('list-1').toArray();
			expect(items).toHaveLength(2);
			expect(fetcher).toHaveBeenCalledTimes(1); // verify passed — no second pull
		});
	});

	describe('post-reconcile convergence check (the lying-read tripwire)', () => {
		// Build the server-side digest entry for a list from the rows the server holds.
		async function serverEntry(rows: { id: string; updated: string }[]): Promise<DigestEntry> {
			const d: Digest = await digestOf(rows);
			return {
				list_id: 'list-1',
				row_count: d.row_count,
				max_updated: d.max_updated,
				hash: d.hash,
				name: 'List',
				membership: membershipFor('list-1')
			};
		}

		async function localDigests(): Promise<Map<string, Digest>> {
			return new Map([['list-1', await localDigest('list-1')]]);
		}

		// The 2026-08-26 CI failure shape: the rule-governed snapshot read returns
		// 200-with-nothing while the raw-SQL digest truthfully reports the server's
		// rows. The cycle must not die silently — verifyConverged logs the lie.
		//
		// (Spy pattern: capture the calls BEFORE mockRestore — restore wipes the
		// call record, so asserting on the spy after the finally block always
		// reads zero and the tripwire looks dead when it fired.)
		async function captureConsoleErrors(run: () => Promise<void>): Promise<unknown[][]> {
			const err = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await run();
				return err.mock.calls.slice();
			} finally {
				err.mockRestore();
			}
		}

		it('a full snapshot that fails to converge logs [sync] reconcile failed to converge', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);

			// Server digest says two rows exist...
			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-b', updated: 't2' }
			]);

			// ...but the fetcher (the rule-filtered read) returns only item-a.
			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', updated: 't1' })],
				categories: []
			});

			const local = await localDigests();
			const calls = await captureConsoleErrors(() =>
				reconcileDivergedLists(
					{ diverged: ['list-1'], server: [server], local },
					fetcher,
					async () => ({
						items: ['item-a', 'item-b'],
						categories: []
					})
				)
			);

			expect(calls).toHaveLength(1);
			expect(String(calls[0]?.[0])).toContain('[sync] reconcile failed to converge list list-1');
			expect(String(calls[0]?.[0])).toContain('server rows=2');
			expect(String(calls[0]?.[0])).toContain('local rows=1');
		});

		it('a DIRECT full snapshot (server max not newer) that fails to converge also logs', async () => {
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);

			// Server max TIES the local max (b is older than a), so the else branch
			// runs the full snapshot directly — no delta, no fallback detour. The
			// lying read hides b from that snapshot too. Pins the call site the
			// delta-fallback test cannot reach.
			const server = await serverEntry([
				{ id: 'item-a', updated: 't1' },
				{ id: 'item-b', updated: 't0' }
			]);

			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', updated: 't1' })],
				categories: []
			});

			const local = await localDigests();
			const calls = await captureConsoleErrors(() =>
				reconcileDivergedLists(
					{ diverged: ['list-1'], server: [server], local },
					fetcher,
					async () => ({
						items: ['item-a', 'item-b'],
						categories: []
					})
				)
			);

			expect(calls).toHaveLength(1);
			expect(String(calls[0]?.[0])).toContain('server rows=2');
			expect(String(calls[0]?.[0])).toContain('local rows=1');
		});

		it('a converged reconcile logs nothing', async () => {
			const server = await serverEntry([{ id: 'item-a', updated: 't1' }]);

			const fetcher: SnapshotFetcher = async () => ({
				items: [seedItem({ id: 'item-a', updated: 't1' })],
				categories: []
			});

			const calls = await captureConsoleErrors(() =>
				reconcileDivergedLists(
					{ diverged: ['list-1'], server: [server], local: new Map() },
					fetcher
				)
			);

			expect(calls).toHaveLength(0);
		});

		it('a row hard-deleted under a queued update converges by the id set, the op still queued', async () => {
			// b carries a pending offline UPDATE and was hard-deleted server-side.
			// Its shadow goes and the row with it, as in the full snapshot, so the
			// repair converges outright — and the queued edit waits for its push to
			// say row_missing.
			await putSynced([seedItem({ id: 'item-a', updated: 't1' })]);
			await putSynced([seedItem({ id: 'item-b', updated: 't9' })]);
			await db.pending_ops.add({
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-b',
				list_id: 'list-1',
				type: 'update',
				changed: { quantity: '9' },
				base: { quantity: '1' },
				queued_at: new Date().toISOString()
			});

			// Server digest: b is gone (hard delete), so only a remains.
			const server = await serverEntry([{ id: 'item-a', updated: 't1' }]);

			const fetcher = vi.fn<SnapshotFetcher>();

			const local = await localDigests();
			const calls = await captureConsoleErrors(() =>
				reconcileDivergedLists(
					{ diverged: ['list-1'], server: [server], local },
					fetcher,
					async () => ({
						items: ['item-a'],
						categories: []
					})
				)
			);

			expect(calls).toHaveLength(0);
			expect(fetcher).not.toHaveBeenCalled();
			expect(await db.items.get('item-b')).toBeUndefined();
			expect(await db.pending_ops.count()).toBe(1);
			expect((await localDigest('list-1')).hash).toBe(server.hash);
		});
	});
});
