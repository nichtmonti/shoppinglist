import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/db.js';
import { authState } from '#lib/auth/state.js';
import { putSynced } from '#lib/test-kit/db.js';
import { runSyncCycle, resetReferenceMirrorCheck } from './cycle';
import { purgeList } from './purge';

describe('sync cycle', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		authState.set({ nickname: null, isValid: false });
		// The seed_version check is once per SESSION (§6.12), and the flag holding
		// that lives for the life of the module — so without this every test after
		// the first would silently skip the mirror step.
		resetReferenceMirrorCheck();
		// Clear all relevant tables
		await db.items.clear();
		await db.list_categories.clear();
		await db.server_items.clear();
		await db.server_list_categories.clear();
		await db.memberships.clear();
		await db.roster.clear();
		await db.lists.clear();
		await db.pending_ops.clear();
		await db.meta.clear();
		// The mirror's self-heal path reads item_dictionary (an empty table means
		// "re-mirror regardless of the version stamp"), so these must start clean
		// too or one test's mirrored rows decide the next test's outcome.
		await db.item_dictionary.clear();
		await db.category_templates.clear();
	});

	// [D-28] The membership set rides on the digest, from a route behind
	// RequireAuth: a rejected token is a 401, never the rule-filtered 200-empty
	// the memberships collection answered with ([D-28]). So the 401 alone
	// expires the session, and nothing is purged.
	const membership = (list: string) => ({
		id: `mem-${list}`,
		account: 'acc1',
		list,
		created: '2026-09-19T08:00:00.000Z',
		updated: '2026-09-19T08:00:00.000Z'
	});
	const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
	const entryFor = (list: string, name = 'Household') => ({
		list_id: list,
		row_count: 0,
		max_updated: '',
		hash: emptyHash,
		name,
		membership: membership(list)
	});
	const quietDeps = () => ({
		drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
		snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
		snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
		mirror: {
			versionTransport: vi.fn().mockResolvedValue('1'),
			referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
		}
	});

	it('a rejected token on the digest expires the session and purges nothing', async () => {
		const cached = membership('list-cached');
		await db.memberships.put(cached);
		authState.set({ nickname: 'Anna', isValid: true });
		const rejected = Object.assign(new Error('sync/digest failed: 401'), { status: 401 });

		await expect(
			runSyncCycle({ ...quietDeps(), digestTransport: vi.fn().mockRejectedValue(rejected) })
		).rejects.toBe(rejected);

		expect(await db.memberships.toArray()).toEqual([cached]);
		let state = { nickname: null as string | null, isValid: true };
		const unsubscribe = authState.subscribe((value) => (state = value));
		unsubscribe();
		expect(state).toEqual({ nickname: null, isValid: false });
	});

	it('a transient digest failure leaves the session alone and purges nothing', async () => {
		const cached = membership('list-cached');
		await db.memberships.put(cached);
		authState.set({ nickname: 'Anna', isValid: true });
		const outage = Object.assign(new Error('sync/digest failed: 502'), { status: 502 });

		await expect(
			runSyncCycle({ ...quietDeps(), digestTransport: vi.fn().mockRejectedValue(outage) })
		).rejects.toBe(outage);

		expect(await db.memberships.toArray()).toEqual([cached]);
		let state = { nickname: null as string | null, isValid: false };
		const unsubscribe = authState.subscribe((value) => (state = value));
		unsubscribe();
		expect(state.isValid).toBe(true);
	});

	it('takes the membership set from the digest by default', async () => {
		await db.memberships.bulkPut([membership('list-keep'), membership('list-gone')]);
		const result = await runSyncCycle({
			...quietDeps(),
			digestTransport: vi.fn().mockResolvedValue([entryFor('list-keep')])
		});

		expect(result.purged).toEqual(['list-gone']);
		expect(await db.memberships.toArray()).toEqual([membership('list-keep')]);
	});

	// A route's pull (mount.ts pullFromServer) runs in any tab and without the
	// loop's notices, so it leaves the queued op to the loop: drained here, a
	// conflict would pass in silence, and a follower tab would be a second
	// drainer (§8.7 [D-109]).
	it('push: false pulls and leaves the outbox alone, the gone notice included', async () => {
		await db.memberships.bulkPut([membership('list-keep'), membership('list-gone')]);
		await db.lists.put({ id: 'list-gone', name: 'Garten', updated: '' });
		await db.pending_ops.put({
			op_id: 'op-1',
			collection: 'items',
			record_id: 'item-1',
			list_id: 'list-keep',
			type: 'update',
			changed: { note: 'x' },
			base: { note: null },
			queued_at: '2026-09-24T08:00:00.000Z'
		});
		const deps = quietDeps();
		const onGone = vi.fn();
		const result = await runSyncCycle({
			...deps,
			push: false,
			drain: { ...deps.drain, onGone },
			digestTransport: vi.fn().mockResolvedValue([entryFor('list-keep')])
		});

		expect(deps.drain.transport).not.toHaveBeenCalled();
		expect(await db.pending_ops.count()).toBe(1);
		expect(result.purged).toEqual(['list-gone']);
		expect(onGone).toHaveBeenCalledWith('list-gone', 'Garten');
	});

	it('a membership re-made under a new id replaces the old row for its list', async () => {
		// Left and re-joined on another device while this one was away: the
		// server's membership for list-a is a new record, the local one is stale.
		await db.memberships.put({ ...membership('list-a'), id: 'mem-old' });
		const result = await runSyncCycle({
			...quietDeps(),
			digestTransport: vi.fn().mockResolvedValue([entryFor('list-a')])
		});

		expect(result.purged).toEqual([]);
		expect(await db.memberships.toArray()).toEqual([membership('list-a')]);
	});

	// [D-08]: the list's name is one name, every member's, and it rides on the
	// digest. A co-member's rename reaches this device as a changed entry name,
	// and it replaces the one this device held.
	it('a co-member’s rename arrives: the digest entry’s name replaces the local one', async () => {
		await db.memberships.put(membership('list-a'));
		await db.lists.put({ id: 'list-a', name: 'Old name', updated: '' });

		await runSyncCycle({
			...quietDeps(),
			digestTransport: vi.fn().mockResolvedValue([entryFor('list-a', 'New name')])
		});

		expect(await db.lists.get('list-a')).toEqual({ id: 'list-a', name: 'New name', updated: '' });
		// The membership row carries no name at all any more.
		expect(await db.memberships.get('mem-list-a')).toEqual(membership('list-a'));
	});

	it('a newly joined list has its name before its items are pulled', async () => {
		// The home reads "pulled" off memberships_synced_at ([D-182]); a list it
		// then shows must already have its name, not wait out the reconcile.
		let releaseSnapshot!: (v: { items: []; categories: [] }) => void;
		const snapshotFetcher = vi.fn(
			() => new Promise<{ items: []; categories: [] }>((resolve) => (releaseSnapshot = resolve))
		);
		const cycle = runSyncCycle({
			...quietDeps(),
			// A hash the empty local copy cannot match: the list is diverged, so the
			// cycle pulls it — and is held mid-pull here.
			digestTransport: vi
				.fn()
				.mockResolvedValue([{ ...entryFor('list-new', 'Grillfest'), hash: 'X' }]),
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] })
		});

		try {
			await vi.waitFor(() => expect(snapshotFetcher).toHaveBeenCalled());
			expect((await db.meta.get('memberships_synced_at'))?.value).toBeTruthy();
			expect((await db.lists.get('list-new'))?.name).toBe('Grillfest');
			// …but not yet its `updated`: that is the home's "pulled" signal ([D-185]),
			// and a count read now would say "leer" for a list still downloading.
			expect((await db.lists.get('list-new'))?.updated).toBeUndefined();
		} finally {
			// Cycles serialize: a held one would stall every later test's.
			releaseSnapshot?.({ items: [], categories: [] });
			await cycle;
		}
		expect((await db.lists.get('list-new'))?.updated).toBeDefined();
	});

	it('runSyncCycle drains, reconciles diverged, stamps last_synced_at', async () => {
		const listId = 'listA';
		// Seed local membership for the diverged list
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: listId,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});

		// Seed a pending op so drainOutbox actually calls the transport.
		await db.pending_ops.put({
			op_id: 'op1',
			collection: 'items',
			record_id: 'item-new',
			list_id: listId,
			type: 'create',
			changed: { name: 'Eggs', quantity: '1' },
			base: {},
			queued_at: '2024-01-01T00:00:00.000Z'
		});

		const drainTransport = vi.fn().mockResolvedValue({
			results: [
				{
					op_id: 'op1',
					status: 'applied',
					record: {
						id: 'item-new',
						list: listId,
						name: 'Eggs',
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
						updated: '2024-01-01T00:00:01.000Z',
						created: '2024-01-01T00:00:01.000Z',
						deleted_at: null
					}
				}
			]
		});
		const digestTransport = vi.fn().mockResolvedValue([
			// Different from local (local is empty, hash = sha256('') !== 'X')
			{ ...entryFor(listId, 'Alice'), hash: 'X' }
		]);
		const snapshotFetcher = vi.fn().mockResolvedValue({ items: [], categories: [] });
		const versionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher = vi.fn().mockResolvedValue({ templates: [], dictionary: [] });

		const result = await runSyncCycle({
			drain: { transport: drainTransport },
			digestTransport,
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		});

		expect(drainTransport).toHaveBeenCalledTimes(1);
		expect(snapshotFetcher).toHaveBeenCalledWith(listId);
		expect(result.drained).toBe(1); // 1 op applied
		expect(result.diverged).toEqual([listId]);
		expect(result.purged).toEqual([]);

		const lastSyncedAt = await db.meta.get('last_synced_at');
		expect(lastSyncedAt?.value).toBeTruthy();
		expect(typeof lastSyncedAt?.value).toBe('string');
	});

	it('runSyncCycle purges a vanished list (the digest membership set)', async () => {
		const listId = 'listA';
		// Seed local membership + items + pending op for listA
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: listId,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});
		await db.lists.put({ id: listId, name: 'Alice', updated: '2024-01-01T00:00:00.000Z' });
		await db.items.put({
			id: 'item1',
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
			updated: '2024-01-01T00:00:00.000Z',
			created: '2024-01-01T00:00:00.000Z',
			deleted_at: null
		});
		await db.pending_ops.put({
			op_id: 'op1',
			collection: 'items',
			record_id: 'item1',
			list_id: listId,
			type: 'update',
			changed: { name: 'Milk' },
			base: { name: 'Milk' },
			queued_at: '2024-01-01T00:00:00.000Z'
		});

		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		// The digest lists memberships for OTHER lists, but NOT listA → listA is vanished.
		const digestTransport = vi.fn().mockResolvedValue([entryFor('list-other')]);
		const snapshotFetcher = vi.fn().mockResolvedValue({ items: [], categories: [] });
		const versionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher = vi.fn().mockResolvedValue({ templates: [], dictionary: [] });

		const onGone = vi.fn();
		const result = await runSyncCycle({
			drain: { transport: drainTransport, onGone },
			digestTransport,
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		});

		expect(result.purged).toEqual([listId]);
		// The only path that learns a list is gone raises the §8.6 notice, named
		// from the list row the purge deletes ([D-138], [D-08]).
		expect(onGone).toHaveBeenCalledExactlyOnceWith(listId, 'Alice');
		// Verify all data for listA is gone
		expect(await db.items.where('list').equals(listId).count()).toBe(0);
		expect(await db.pending_ops.where('list_id').equals(listId).count()).toBe(0);
		expect(await db.memberships.where('list').equals(listId).count()).toBe(0);
		expect(await db.lists.get(listId)).toBeUndefined();
	});

	// A valid empty set is authoritative ([D-28]): a user who loses their only
	// membership must not keep the list forever. A response that is not
	// membership data (an SPA index.html answered with 200) is rejected by
	// shape instead — see audit-repro.test.ts W7.
	it('runSyncCycle purges on a legitimately empty membership response ([D-28])', async () => {
		const listId = 'listA';
		// Seed local membership + items for listA
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: listId,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});
		await db.lists.put({ id: listId, name: 'Alice', updated: '2024-01-01T00:00:00.000Z' });
		await db.items.put({
			id: 'item1',
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
			updated: '2024-01-01T00:00:00.000Z',
			created: '2024-01-01T00:00:00.000Z',
			deleted_at: null
		});

		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		const digestTransport = vi.fn().mockResolvedValue([]);
		const snapshotFetcher = vi.fn().mockResolvedValue({ items: [], categories: [] });
		// The account genuinely has no memberships left — the honest answer for
		// "you were removed from the last list you were on". An empty digest IS
		// that answer ([D-28]): no separate membership read.
		const versionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher = vi.fn().mockResolvedValue({ templates: [], dictionary: [] });

		const result = await runSyncCycle({
			drain: { transport: drainTransport },
			digestTransport,
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		});

		expect(result.purged).toEqual([listId]);
		expect(await db.items.where('list').equals(listId).count()).toBe(0);
		expect(await db.lists.get(listId)).toBeUndefined();
		expect(await db.memberships.where('list').equals(listId).count()).toBe(0);
	});

	it('runSyncCycle keeps a list that is still a membership', async () => {
		const listId = 'listA';
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: listId,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});
		await db.lists.put({ id: listId, name: 'Alice', updated: '2024-01-01T00:00:00.000Z' });
		await putSynced([
			{
				id: 'item1',
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
				updated: '2024-01-01T00:00:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			}
		]);

		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		// The digest still carries the membership → listA is NOT vanished
		const digestTransport = vi.fn().mockResolvedValue([
			{
				...entryFor(listId, 'Alice'),
				row_count: 1,
				max_updated: '2024-01-01T00:00:00.000Z',
				hash: await sha256('item1:2024-01-01T00:00:00.000Z') // matches the local digest
			}
		]);
		const snapshotFetcher = vi.fn().mockResolvedValue({ items: [], categories: [] });
		const versionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher = vi.fn().mockResolvedValue({ templates: [], dictionary: [] });

		const result = await runSyncCycle({
			drain: { transport: drainTransport },
			digestTransport,
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		});

		expect(result.purged).toEqual([]);
		// Verify data for listA is intact
		expect(await db.items.where('list').equals(listId).count()).toBe(1);
		expect(await db.lists.get(listId)).not.toBeUndefined();
	});

	it('a newly-joined list is pulled via digest divergence', async () => {
		const listB = 'listB';
		// No local membership for listB initially
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: 'listA', // Different list
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});

		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		// The digest carries a NEW membership for listB
		const digestTransport = vi.fn().mockResolvedValue([
			entryFor('listA'),
			{ ...entryFor(listB, 'Grillfest'), hash: 'X' } // Diverged (listB not in local)
		]);
		const snapshotFetcher = vi.fn().mockResolvedValue({
			items: [
				{
					id: 'item1',
					list: listB,
					name: 'Bread',
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
					deleted_at: null
				}
			],
			categories: []
		});
		const versionTransport = vi.fn().mockResolvedValue('1');
		const referenceFetcher = vi.fn().mockResolvedValue({ templates: [], dictionary: [] });

		const result = await runSyncCycle({
			drain: { transport: drainTransport },
			digestTransport,
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		});

		expect(result.diverged).toContain(listB);
		// Verify listB's items are reconciled (in db)
		const items = await db.items.where('list').equals(listB).toArray();
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('Bread');
		// Verify the membership for listB is upserted, and the list arrives named
		const mem = await db.memberships.get(membership(listB).id);
		expect(mem?.list).toBe(listB);
		expect((await db.lists.get(listB))?.name).toBe('Grillfest');
	});

	it('mirror error does not abort the cycle', async () => {
		const listId = 'listA';
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: listId,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});

		const drainTransport = vi.fn().mockResolvedValue({ results: [] });
		const digestTransport = vi.fn().mockResolvedValue([entryFor(listId)]);
		const snapshotFetcher = vi.fn().mockResolvedValue({ items: [], categories: [] });
		const versionTransport = vi.fn().mockRejectedValue(new Error('Mirror fetch failed'));
		const referenceFetcher = vi.fn().mockResolvedValue({ templates: [], dictionary: [] });

		const result = await runSyncCycle({
			drain: { transport: drainTransport },
			digestTransport,
			snapshotFetcher,
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		});

		expect(versionTransport).toHaveBeenCalledTimes(1);
		expect(result.mirrored).toBe(false);
		// The cycle should still complete and stamp
		const lastSyncedAt = await db.meta.get('last_synced_at');
		expect(lastSyncedAt?.value).toBeTruthy();
	});

	// [D-182]: the home's "not pulled yet" vs "no lists" signal. Stamped as soon
	// as the memberships land — an EMPTY set included, that is the answer a new
	// account waits for — and not held back by the slow tail of the cycle.
	it('stamps memberships_synced_at once the memberships land, ahead of the mirror', async () => {
		let releaseMirror!: (v: string) => void;
		const versionTransport = vi.fn(
			() => new Promise<string>((resolve) => (releaseMirror = resolve))
		);
		const cycle = runSyncCycle({
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport: vi.fn().mockResolvedValue([]),
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport,
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});

		await vi.waitFor(() => expect(versionTransport).toHaveBeenCalled());
		expect((await db.meta.get('memberships_synced_at'))?.value).toBeTruthy();
		expect(await db.meta.get('last_synced_at')).toBeUndefined();

		releaseMirror('1');
		await cycle;
	});

	it('leaves memberships_synced_at unset when the digest fails', async () => {
		await expect(
			runSyncCycle({
				drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
				digestTransport: vi.fn().mockRejectedValue(new Error('network down'))
			})
		).rejects.toThrow('network down');
		expect(await db.meta.get('memberships_synced_at')).toBeUndefined();
	});

	it('checks seed_version once per session, not once per cycle (§6.12)', async () => {
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: 'listA',
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});

		const versionTransport = vi.fn().mockResolvedValue('1');
		// A non-empty dictionary is what makes this a SUCCESSFUL mirror: the mirror
		// rejects an empty one as a broken fetch, which would leave the per-session
		// flag unset and re-check the version every cycle — the opposite of the
		// behaviour under test.
		const referenceFetcher = vi.fn().mockResolvedValue({
			templates: [],
			dictionary: [
				{ id: 'item_gurke', names_i18n: { de: ['Gurke'] }, default_category: null, popularity: 1 }
			]
		});
		const deps = {
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport: vi.fn().mockResolvedValue([]),
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: { versionTransport, referenceFetcher }
		};

		const first = await runSyncCycle(deps);
		const second = await runSyncCycle(deps);
		const third = await runSyncCycle(deps);

		// The ~60s tick would otherwise spend one request per cycle to learn that
		// the operator has not shipped a new seed.
		expect(versionTransport).toHaveBeenCalledTimes(1);
		expect(first.mirrored).toBe(true);
		expect(second.mirrored).toBe(false);
		expect(third.mirrored).toBe(false);

		// A reload (new session) re-checks.
		resetReferenceMirrorCheck();
		await runSyncCycle(deps);
		expect(versionTransport).toHaveBeenCalledTimes(2);
	});

	it('refreshes the lists store — name and activity — from the digest', async () => {
		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: 'listA',
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});

		await runSyncCycle({
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport: vi.fn().mockResolvedValue([
				{
					...entryFor('listA', 'Wocheneinkauf'),
					row_count: 2,
					max_updated: '2024-03-02 10:00:00.000Z',
					hash: 'h'
				},
				{ ...entryFor('listB', 'Baumarkt'), hash: 'z' }
			]),
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});

		// `updated` is the list's newest item/category timestamp — what §9.3's
		// default "recent activity" home ordering sorts on.
		expect(await db.lists.get('listA')).toEqual({
			id: 'listA',
			name: 'Wocheneinkauf',
			updated: '2024-03-02 10:00:00.000Z'
		});
		expect(await db.lists.get('listB')).toEqual({ id: 'listB', name: 'Baumarkt', updated: '' });
	});

	// The ambient loop's cycles and the inline ones createList() / joinList()
	// run (§7.5/§7.6) must not overlap: the PocketBase SDK auto-cancels an
	// in-flight request when an identical one is issued, so two cycles' fetches
	// would cancel each other and the loser reject. createList() awaits its cycle
	// before navigating, so the user would see a generic error and stay on the
	// home screen with the list already made.
	it('serializes overlapping cycles instead of letting them race', async () => {
		let active = 0;
		let maxActive = 0;
		const digestTransport = vi.fn(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return [];
		});
		const deps = () => ({
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport,
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});

		await Promise.all([runSyncCycle(deps()), runSyncCycle(deps()), runSyncCycle(deps())]);

		expect(digestTransport).toHaveBeenCalledTimes(3);
		expect(maxActive).toBe(1);
	});

	// A rejected cycle must not poison the chain for every later caller — the
	// ambient loop would go permanently silent after one transient failure.
	it('keeps running cycles after one of them rejects', async () => {
		const failing = runSyncCycle({
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport: vi.fn().mockRejectedValue(new Error('autocancelled'))
		});
		await expect(failing).rejects.toThrow('autocancelled');

		await db.memberships.put({
			id: 'mem1',
			account: 'acc1',
			list: 'listA',
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});
		const result = await runSyncCycle({
			drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
			digestTransport: vi.fn().mockResolvedValue([entryFor('listA')]),
			snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
			mirror: {
				versionTransport: vi.fn().mockResolvedValue('1'),
				referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
			}
		});
		expect(result.purged).toEqual([]);
		expect(await db.meta.get('last_synced_at')).toBeDefined();
	});

	it('purgeList directly removes all data for a list, preserving other lists', async () => {
		const listX = 'listX';
		const listY = 'listY';

		// Seed data for listX
		await db.lists.put({ id: listX, name: 'Alice', updated: '2024-01-01T00:00:00.000Z' });
		await db.memberships.put({
			id: 'memX',
			account: 'acc1',
			list: listX,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});
		await db.items.put({
			id: 'itemX',
			list: listX,
			name: 'X',
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
			deleted_at: null
		});
		await db.list_categories.put({
			id: 'catX',
			list: listX,
			slug: null,
			name: 'CatX',
			icon: 'icon',
			color: 'red',
			sort_order: 0,
			updated: '2024-01-01T00:00:00.000Z',
			created: '2024-01-01T00:00:00.000Z',
			deleted_at: null
		});
		await db.roster.put({
			id: `${listX}_acc1`,
			list: listX,
			account: 'acc1',
			nickname: 'Alice',
			joined: '2024-01-01T00:00:00.000Z'
		});
		await db.pending_ops.put({
			op_id: 'opX',
			collection: 'items',
			record_id: 'itemX',
			list_id: listX,
			type: 'update',
			changed: { name: 'X' },
			base: { name: 'X' },
			queued_at: '2024-01-01T00:00:00.000Z'
		});

		// Seed data for listY (should survive)
		await db.lists.put({ id: listY, name: 'Bob', updated: '2024-01-01T00:00:00.000Z' });
		await db.memberships.put({
			id: 'memY',
			account: 'acc1',
			list: listY,
			created: '2024-01-01T00:00:00.000Z',
			updated: '2024-01-01T00:00:00.000Z'
		});
		await db.items.put({
			id: 'itemY',
			list: listY,
			name: 'Y',
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
			deleted_at: null
		});

		await purgeList(listX);

		// Verify listX's data is all gone
		expect(await db.lists.get(listX)).toBeUndefined();
		expect(await db.memberships.get('memX')).toBeUndefined();
		expect(await db.items.get('itemX')).toBeUndefined();
		expect(await db.list_categories.get('catX')).toBeUndefined();
		expect(await db.roster.get(`${listX}_acc1`)).toBeUndefined();
		expect(await db.pending_ops.get('opX')).toBeUndefined();

		// Verify listY's data survives
		expect(await db.lists.get(listY)).not.toBeUndefined();
		expect(await db.memberships.get('memY')).not.toBeUndefined();
		expect(await db.items.get('itemY')).not.toBeUndefined();
	});

	// [putOnlyChanged] The per-cycle memberships/lists upserts bulkPut only new
	// or field-changed rows: Dexie liveQuery re-emits on ANY table write, so an
	// unconditional bulkPut would re-fire every memberships/listIndex subscriber
	// on each idle tick. Byte-identical server state across two cycles must
	// therefore produce ZERO writes in the second — and a real field change
	// (the list name, digest max_updated, the membership's updated) must still land.
	const membershipOf = (updated: string) => ({
		id: 'mem1',
		account: 'acc1',
		list: 'listA',
		created: '2024-01-01T00:00:00.000Z',
		updated
	});
	const idleCycleDeps = (
		membership: ReturnType<typeof membershipOf>,
		maxUpdated = '',
		name = 'Alice'
	) => ({
		drain: { transport: vi.fn().mockResolvedValue({ results: [] }) },
		digestTransport: vi
			.fn()
			.mockResolvedValue([
				{ list_id: 'listA', row_count: 0, max_updated: maxUpdated, hash: 'X', name, membership }
			]),
		snapshotFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
		snapshotIdsFetcher: vi.fn().mockResolvedValue({ items: [], categories: [] }),
		mirror: {
			versionTransport: vi.fn().mockResolvedValue('1'),
			referenceFetcher: vi.fn().mockResolvedValue({ templates: [], dictionary: [] })
		}
	});

	it('an unchanged second cycle performs no memberships/lists writes', async () => {
		const membership = membershipOf('2024-01-01T00:00:00.000Z');
		// Cycle 1 seeds the local tables from the server.
		await runSyncCycle(idleCycleDeps(membership));
		expect(await db.memberships.toArray()).toEqual([membership]);
		expect(await db.lists.toArray()).toEqual([{ id: 'listA', name: 'Alice', updated: '' }]);

		const membershipsPut = vi.spyOn(db.memberships, 'bulkPut');
		const listsPut = vi.spyOn(db.lists, 'bulkPut');
		try {
			// Cycle 2 sees byte-identical server state.
			await runSyncCycle(idleCycleDeps(membership));
			expect(membershipsPut).not.toHaveBeenCalled();
			expect(listsPut).not.toHaveBeenCalled();
			// Content untouched, not merely re-written identically.
			expect(await db.memberships.toArray()).toEqual([membership]);
			expect(await db.lists.toArray()).toEqual([{ id: 'listA', name: 'Alice', updated: '' }]);
		} finally {
			membershipsPut.mockRestore();
			listsPut.mockRestore();
		}
	});

	it('a changed list name and digest timestamp still land (putOnlyChanged positive path)', async () => {
		await runSyncCycle(idleCycleDeps(membershipOf('2024-01-01T00:00:00.000Z')));

		const later = membershipOf('2024-06-01T00:00:00.000Z');
		await runSyncCycle(idleCycleDeps(later, '2024-06-01T00:00:00.000Z', 'Bob'));

		expect(await db.memberships.get('mem1')).toEqual(later);
		expect(await db.lists.get('listA')).toEqual({
			id: 'listA',
			name: 'Bob',
			updated: '2024-06-01T00:00:00.000Z'
		});
	});
});

// Helper to compute SHA-256 of empty string (matches digest.ts implementation)
async function sha256(s: string): Promise<string> {
	const data = new TextEncoder().encode(s);
	const buf = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
