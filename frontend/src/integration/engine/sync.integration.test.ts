// Two clients scripted through the sync engine's acceptance scenarios:
//
//   create / duplicate-name create /
//   concurrent double check-off / disjoint-field merge / same-field conflict /
//   delete-vs-edit / concurrent delete-delete / vanished list / joined old list
//   hydrated / duplicate-record_id retry / re-edit after conflict /
//   mid-snapshot-fetch create / diverged-only repair.
//
// Every other test layer exercises one half of the sync engine against fakes:
// the Go suite hand-builds ops in Go, the client unit suite drives injected
// transports. Here both halves are real — the shipped binary and the shipped
// client modules — so the wire contract duplicated across
// backend/internal/sync/types.go and src/lib/sync/types.ts is actually executed
// rather than eyeballed.
import type PocketBase from 'pocketbase';
import { afterEach, describe, expect, test } from 'vitest';

import type { ConflictNotice } from '#lib/sync/types.js';
import type { PushResult } from '#lib/sync/types.js';
import type { Item } from '#lib/db.js';

import {
	addMembership,
	adminClient,
	createAccount,
	createList,
	makeClient,
	newId,
	removeMembership,
	serverItem,
	serverItems,
	type Client
} from '../harness';

// --- fixture -----------------------------------------------------------------

interface Fixture {
	admin: PocketBase;
	alice: Client;
	bob: Client;
	listId: string;
}

const openClients: Client[] = [];

afterEach(() => {
	while (openClients.length) openClients.pop()?.close();
});

async function track(client: Client): Promise<Client> {
	openClients.push(client);
	return client;
}

// Two accounts, one list (created through the real §7.5 route so it carries the
// per-list category copies), both clients hydrated from the server.
async function scenario(opts: { joinBob?: boolean } = {}): Promise<Fixture> {
	const admin = await adminClient();
	const alice = await track(await makeClient(await createAccount(admin, 'Alice')));
	const bob = await track(await makeClient(await createAccount(admin, 'Bob')));
	const listId = await createList(alice, 'Alice');
	if (opts.joinBob !== false) await addMembership(admin, listId, bob.account);

	await alice.cycle.runSyncCycle();
	if (opts.joinBob !== false) await bob.cycle.runSyncCycle();
	return { admin, alice, bob, listId };
}

// --- observation without displacing the real transport -----------------------

// Capture the server's push results by intercepting fetch rather than injecting
// a transport, so the code under test keeps using its own default transport
// (headers, URL, error handling included).
async function capturePush<T>(fn: () => Promise<T>): Promise<{ value: T; results: PushResult[] }> {
	const results: PushResult[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const resp = await original(input, init);
		if (String(input instanceof Request ? input.url : input).includes('/api/sync/push')) {
			const body = (await resp.clone().json()) as { results: PushResult[] };
			results.push(...body.results);
		}
		return resp;
	};
	try {
		return { value: await fn(), results };
	} finally {
		globalThis.fetch = original;
	}
}

// --- small helpers -----------------------------------------------------------

async function createItem(
	c: Client,
	listId: string,
	fields: Record<string, unknown>
): Promise<string> {
	const id = newId();
	await c.outbox.createRecord('items', listId, id, fields);
	return id;
}

async function localItem(c: Client, id: string): Promise<Item> {
	const row = await c.db.items.get(id);
	if (!row) throw new Error(`local item ${id} not found`);
	return row;
}

// Edit through the outbox the way the UI will: read the current row, then apply
// the delta against it (that read is what captures `base`).
async function editItem(
	c: Client,
	listId: string,
	id: string,
	changed: Record<string, unknown>
): Promise<void> {
	await c.outbox.updateRecord('items', await localItem(c, id), changed);
}

async function deleteItem(c: Client, listId: string, id: string): Promise<void> {
	await c.outbox.deleteRecord('items', await localItem(c, id));
}

// --- scenarios ---------------------------------------------------------------

describe('two clients against the real backend', () => {
	test('wire contract: the client digest matches the server digest byte for byte', async () => {
		const { alice, listId } = await scenario();
		await createItem(alice, listId, { name: 'Milk', quantity: '2' });
		await alice.cycle.runSyncCycle();

		const local = await alice.digest.localDigest(listId);
		const server = (await alice.probe()).server.find((d) => d.list_id === listId);

		// The two digest implementations live in different languages over the same
		// `updated` timestamps. A drift here would leave every list permanently
		// "diverged" and pull a full snapshot on every cycle.
		expect(server).toBeDefined();
		expect(local.hash).toBe(server!.hash);
		expect(local.row_count).toBe(server!.row_count);
		expect(local.max_updated).toBe(server!.max_updated);
	});

	test('create: A creates an item and B sees it', async () => {
		const { admin, alice, bob, listId } = await scenario();

		const itemId = await createItem(alice, listId, { name: 'Milk', quantity: '2' });
		const { value: summary, results } = await capturePush(() => alice.push.drainOutbox());

		expect(summary).toEqual({ drained: 1, failed: 0, requeued: 0 });
		expect(results.map((r) => r.status)).toEqual(['applied']);

		// The optimistic row is replaced by the server's, stamped and identified.
		const settled = await localItem(alice, itemId);
		expect(settled.modified_by).toBe(alice.account.id);
		expect(settled.updated).not.toBe('');
		expect(await alice.db.pending_ops.count()).toBe(0);

		await bob.cycle.runSyncCycle();
		expect(await localItem(bob, itemId)).toEqual(settled);

		// The cycle also refreshes db.lists from the digest it already fetched:
		// the list's one name ([D-08]; the harness creates it named "Alice"),
		// and `updated`, its newest row timestamp (§9.3 "recent activity").
		expect(await bob.db.lists.get(listId)).toEqual({
			id: listId,
			name: 'Alice',
			updated: settled.updated
		});

		const onServer = await serverItems(admin, listId);
		expect(onServer.map((r) => r.name)).toEqual(['Milk']);
	});

	test('category create: the editor\'s "add" is applied, and B sees the row', async () => {
		const { admin, alice, bob, listId } = await scenario();

		// Through the app's own action, not a hand-built op: `slug` is
		// server-owned ([D-08]), so an action that sent one would have EVERY added
		// category refused as field_unknown — shown optimistically, then dropped
		// under the generic "could not be synced" toast. Only a category created
		// end to end against the real server can see that.
		const catId = await alice.categories.addCategory(listId, {
			name: 'Drogerie',
			icon: '🧴',
			color: 'teal',
			sort_order: 99
		});
		const { results } = await capturePush(() => alice.push.drainOutbox());

		expect(results.map((r) => [r.status, r.reason ?? null])).toEqual([['applied', null]]);
		expect(await alice.db.pending_ops.count()).toBe(0);
		expect((await alice.db.list_categories.get(catId))?.name).toBe('Drogerie');

		await bob.cycle.runSyncCycle();
		const seen = await bob.db.list_categories.get(catId);
		expect(seen).toMatchObject({ name: 'Drogerie', icon: '🧴', color: 'teal', slug: null });

		const onServer = await admin.collection('list_categories').getOne(catId);
		expect(onServer.slug).toBe('');
	});

	test('duplicate-name create: B merges into A row and remaps the dead id', async () => {
		const { admin, alice, bob, listId } = await scenario();

		const aliceItem = await createItem(alice, listId, { name: 'Milk', quantity: '2' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		// Same normalized name, different client-generated id (§8.3 [D-29]).
		const bobItem = await createItem(bob, listId, { name: '  MILK  ', quantity: '3' });
		const notices: ConflictNotice[] = [];
		const { results } = await capturePush(() =>
			bob.push.drainOutbox({ onConflict: (n) => notices.push(n) })
		);

		expect(results.map((r) => r.status)).toEqual(['merged']);
		expect(results[0].record_id).toBe(aliceItem);

		// The orphaned optimistic row is gone; the survivor is present.
		expect(await bob.db.items.get(bobItem)).toBeUndefined();
		expect((await localItem(bob, aliceItem)).name).toBe('Milk');
		expect(await bob.db.pending_ops.count()).toBe(0);

		// quantity differed from the survivor's, so it surfaces as toast copy.
		// The notice names the SURVIVOR ([D-40]): the settle deletes the dead
		// row before the notice is emitted, so a formatter keyed on the dead id
		// could never resolve the article name.
		expect(notices).toHaveLength(1);
		expect(notices[0].kind).toBe('merged');
		expect(notices[0].record_id).toBe(aliceItem);
		expect(notices[0].conflicts.map((c) => c.field)).toEqual(['quantity']);

		// One row on the server, not two.
		expect(await serverItems(admin, listId)).toHaveLength(1);
	});

	// A blank is not a value ([D-29]): the survivor takes the quantity the
	// merged create carried, and nothing was lost, so no notice.
	test('duplicate-name create into a row without a quantity fills it, silently', async () => {
		const { admin, alice, bob, listId } = await scenario();
		const aliceItem = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		await createItem(bob, listId, { name: 'milk', quantity: '3' });
		const notices: ConflictNotice[] = [];
		const { results } = await capturePush(() =>
			bob.push.drainOutbox({ onConflict: (n) => notices.push(n) })
		);

		expect(results.map((r) => r.status)).toEqual(['merged']);
		expect(notices).toHaveLength(0);
		expect((await localItem(bob, aliceItem)).quantity).toBe('3');
		await alice.cycle.runSyncCycle();
		expect((await localItem(alice, aliceItem)).quantity).toBe('3');
		expect(await serverItems(admin, listId)).toHaveLength(1);
	});

	test('concurrent double check-off: second push is a noop and both converge', async () => {
		const { alice, bob, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		// Both check the item while offline.
		await editItem(alice, listId, itemId, { checked: true });
		await editItem(bob, listId, itemId, { checked: true });

		const a = await capturePush(() => alice.push.drainOutbox());
		const b = await capturePush(() => bob.push.drainOutbox());

		expect(a.results.map((r) => r.status)).toEqual(['applied']);
		expect(b.results.map((r) => r.status)).toEqual(['noop']);

		const aliceRow = await localItem(alice, itemId);
		const bobRow = await localItem(bob, itemId);
		expect(aliceRow.checked).toBe(true);
		// One server-stamped instant, not two clock readings ([D-26]).
		expect(bobRow.checked_at).toBe(aliceRow.checked_at);
		expect(bobRow.last_bought_at).toBe(aliceRow.last_bought_at);
	});

	test('disjoint-field merge: both edits survive', async () => {
		const { admin, alice, bob, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		await editItem(alice, listId, itemId, { quantity: '3' });
		await editItem(bob, listId, itemId, { note: 'organic' });

		const a = await capturePush(() => alice.push.drainOutbox());
		const b = await capturePush(() => bob.push.drainOutbox());

		expect(a.results.map((r) => r.status)).toEqual(['applied']);
		expect(b.results.map((r) => r.status)).toEqual(['applied']);

		const onServer = await serverItem(admin, itemId);
		expect(onServer.quantity).toBe('3');
		expect(onServer.note).toBe('organic');

		// Alice's client only learns about the note on its next inbound pass.
		await alice.snapshot.reconcileList(listId);
		expect((await localItem(alice, itemId)).note).toBe('organic');
	});

	test('category reassignment reaches a second client on the first change', async () => {
		const { admin, alice, bob, listId } = await scenario();
		const categories = await alice.db.list_categories.where('list').equals(listId).toArray();
		const produce = categories.find((category) => category.slug === 'produce');
		expect(produce).toBeDefined();

		// A custom/as-typed item starts in Others (null category_key), matching the
		// reported production path rather than a seeded dictionary suggestion.
		const itemId = await createItem(alice, listId, { name: 'Drachenfrucht' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();
		expect((await localItem(bob, itemId)).category_key).toBeNull();

		await editItem(alice, listId, itemId, { category_key: produce!.id });
		const { results } = await capturePush(() => alice.push.drainOutbox());
		expect(results.map((r) => r.status)).toEqual(['applied']);

		await bob.cycle.runSyncCycle();
		expect((await localItem(bob, itemId)).category_key).toBe(produce!.id);
		expect((await serverItem(admin, itemId)).category_key).toBe(produce!.id);
	});

	test('same-field conflict: first committed wins, loser is told', async () => {
		const { alice, bob, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		await editItem(alice, listId, itemId, { quantity: '2' });
		await editItem(bob, listId, itemId, { quantity: '3' });

		await alice.push.drainOutbox();
		const notices: ConflictNotice[] = [];
		const { results } = await capturePush(() =>
			bob.push.drainOutbox({ onConflict: (n) => notices.push(n) })
		);

		expect(results.map((r) => r.status)).toEqual(['partial']);
		expect(results[0].conflicts).toEqual([
			{ field: 'quantity', mine: '3', theirs: '2', theirs_by: alice.account.id }
		]);

		// Bob's optimistic '3' is replaced by the winning value and the op clears.
		expect((await localItem(bob, itemId)).quantity).toBe('2');
		expect(await bob.db.pending_ops.count()).toBe(0);
		expect(notices.map((n) => n.kind)).toEqual(['partial']);
	});

	// The `denied` path against the real enforcement. Worth an integration test rather
	// than a unit one because the whole failure was a disagreement BETWEEN the two
	// halves: the server capped `note` at 4096 bytes and the client neither knew the
	// cap nor did anything with the refusal, so an over-long note was accepted locally,
	// refused on the wire, and dropped without a trace. Both halves now read the cap
	// from backend/internal/fieldcontract/field-contract.json, and this drives the
	// shipped binary, so a cap that drifts on one side fails here.
	test('denied (field too long): the row reverts and the client is told why', async () => {
		const { admin, alice, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk', note: 'short note' });
		await alice.push.drainOutbox();
		expect((await serverItem(admin, itemId)).note).toBe('short note');

		// Over the contract's 4096-byte cap for items.note. `maxlength` on the input
		// makes this hard to reach by typing, but paste and non-ASCII both get past it.
		await editItem(alice, listId, itemId, { note: 'x'.repeat(5000) });
		expect((await localItem(alice, itemId)).note).toHaveLength(5000); // optimistic

		const denials: { reason?: string; field?: string }[] = [];
		const { results } = await capturePush(() =>
			alice.push.drainOutbox({
				onDenied: (n) => denials.push({ reason: n.reason, field: n.field })
			})
		);

		expect(results.map((r) => r.status)).toEqual(['denied']);
		expect(denials).toEqual([{ reason: 'field_too_long', field: 'note' }]);

		// The refused value is gone from the row — it shows the server's state again,
		// not left sitting there for the digest to never notice.
		expect((await localItem(alice, itemId)).note).toBe('short note');
		expect(await alice.db.pending_ops.count()).toBe(0);

		// The row is recomputed from its shadow, which holds what the server has
		// right now — so, unlike [D-40]'s revert to the enqueue-time base, there
		// is nothing for a repair pull to settle: the digest already agrees.
		expect((await alice.probe()).diverged).toEqual([]);
	});

	test('re-edit after conflict: the losing client can retry from the settled base', async () => {
		const { admin, alice, bob, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		await editItem(alice, listId, itemId, { quantity: '2' });
		await editItem(bob, listId, itemId, { quantity: '3' });
		await alice.push.drainOutbox();
		await bob.push.drainOutbox(); // partial: bob now holds '2'

		// Bob edits again; `base` is captured off the settled row, so it applies.
		await editItem(bob, listId, itemId, { quantity: '5' });
		const { results } = await capturePush(() => bob.push.drainOutbox());

		expect(results.map((r) => r.status)).toEqual(['applied']);
		expect((await serverItem(admin, itemId)).quantity).toBe('5');
		expect((await localItem(bob, itemId)).quantity).toBe('5');
	});

	test('delete-vs-edit: the edit loses to the tombstone', async () => {
		const { alice, bob, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		await deleteItem(alice, listId, itemId);
		await editItem(bob, listId, itemId, { note: 'organic' });

		await alice.push.drainOutbox();
		const notices: ConflictNotice[] = [];
		const { results } = await capturePush(() =>
			bob.push.drainOutbox({ onConflict: (n) => notices.push(n) })
		);

		expect(results.map((r) => r.status)).toEqual(['deleted_conflict']);
		expect(notices.map((n) => n.kind)).toEqual(['deleted_conflict']);

		const bobRow = await localItem(bob, itemId);
		const aliceRow = await localItem(alice, itemId);
		expect(bobRow.deleted_at).toBe(aliceRow.deleted_at);
		// The local optimistic tombstone is replaced by the server's stamp ([D-45]).
		expect(bobRow.deleted_at).not.toBeNull();
		expect(bobRow.note).toBeNull();
		expect(await bob.db.pending_ops.count()).toBe(0);
	});

	test('concurrent delete-delete: converges without a conflict notice', async () => {
		const { alice, bob, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		await deleteItem(alice, listId, itemId);
		await deleteItem(bob, listId, itemId);

		await alice.push.drainOutbox();
		const notices: ConflictNotice[] = [];
		const { results } = await capturePush(() =>
			bob.push.drainOutbox({ onConflict: (n) => notices.push(n) })
		);

		expect(results.map((r) => r.status)).toEqual(['noop']);
		expect(notices).toHaveLength(0);
		expect((await localItem(bob, itemId)).deleted_at).toBe(
			(await localItem(alice, itemId)).deleted_at
		);
	});

	test('vanished list: the digest membership set purges every local trace', async () => {
		const { admin, alice, bob, listId } = await scenario();
		// Create a second list that Bob stays a member of — the empty-set guard
		// requires a non-empty membership response to exercise the purge.
		const listIdOther = await createList(alice, 'AliceOther');
		await addMembership(admin, listIdOther, bob.account);
		await alice.cycle.runSyncCycle();
		await bob.cycle.runSyncCycle();

		await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		expect(await bob.db.items.where('list').equals(listId).count()).toBeGreaterThan(0);
		expect(await bob.db.list_categories.where('list').equals(listId).count()).toBeGreaterThan(0);

		await removeMembership(admin, listId, bob.account);
		const result = await bob.cycle.runSyncCycle();

		expect(result.purged).toEqual([listId]);
		expect(await bob.db.items.where('list').equals(listId).count()).toBe(0);
		expect(await bob.db.list_categories.where('list').equals(listId).count()).toBe(0);
		expect(await bob.db.memberships.where('list').equals(listId).count()).toBe(0);
		expect(await bob.db.pending_ops.where('list_id').equals(listId).count()).toBe(0);
		expect(await bob.db.lists.get(listId)).toBeUndefined();
	});

	test('joined old list hydrated: a new member pulls the full history', async () => {
		const { admin, alice, bob, listId } = await scenario({ joinBob: false });

		await createItem(alice, listId, { name: 'Milk' });
		await createItem(alice, listId, { name: 'Bread' });
		await alice.push.drainOutbox();

		// Bob has no local trace of the list at all before joining.
		expect(await bob.db.items.count()).toBe(0);

		await addMembership(admin, listId, bob.account);
		const result = await bob.cycle.runSyncCycle();

		expect(result.diverged).toEqual([listId]);
		const bobNames = (await bob.db.items.where('list').equals(listId).toArray())
			.map((i) => i.name)
			.sort();
		expect(bobNames).toEqual(['Bread', 'Milk']);
		// The per-list category copies hydrate too, not just the items.
		expect(await bob.db.list_categories.where('list').equals(listId).count()).toBeGreaterThan(0);
	});

	test('duplicate-record_id retry: a lost response replays as a noop, not a second row', async () => {
		const { admin, alice, listId } = await scenario();
		const itemId = await createItem(alice, listId, { name: 'Milk' });

		// The server commits, then the connection drops before the client reads the
		// reply — the case [D-42]'s duplicate-record_id branch exists for.
		const original = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const resp = await original(input, init);
			if (String(input instanceof Request ? input.url : input).includes('/api/sync/push')) {
				throw new Error('connection reset after the server committed');
			}
			return resp;
		};
		const firstDrain = await alice.push.drainOutbox().finally(() => {
			globalThis.fetch = original;
		});

		expect(firstDrain).toEqual({ drained: 0, failed: 1, requeued: 0, error: expect.anything() });
		expect(await alice.db.pending_ops.count()).toBe(1);
		expect(await serverItems(admin, listId)).toHaveLength(1);

		// The retry re-sends the same create op with the same record_id.
		const { value: secondDrain, results } = await capturePush(() => alice.push.drainOutbox());

		expect(results.map((r) => r.status)).toEqual(['noop']);
		expect(secondDrain).toEqual({ drained: 1, failed: 0, requeued: 0 });
		expect(await serverItems(admin, listId)).toHaveLength(1);
		expect((await localItem(alice, itemId)).name).toBe('Milk');
	});

	test('mid-snapshot-fetch create survives the reconcile [D-40]', async () => {
		const { admin, alice, listId } = await scenario();
		const existing = await createItem(alice, listId, { name: 'Milk' });
		await alice.push.drainOutbox();

		// Enqueue a create in the window between the snapshot fetch returning and
		// the reconcile transaction opening. The server rows are therefore stale
		// with respect to the new row, and only the existence guard saves it.
		const raced = newId();
		await alice.snapshot.reconcileList(listId, async (id) => {
			const [items, categories] = await Promise.all([
				alice.pb
					.collection('items')
					.getFullList({ filter: alice.pb.filter('list = {:id}', { id }) }),
				alice.pb
					.collection('list_categories')
					.getFullList({ filter: alice.pb.filter('list = {:id}', { id }) })
			]);
			await alice.outbox.createRecord('items', listId, raced, { name: 'Butter' });
			return {
				items: items.map((r) =>
					alice.record.normalizeItem(r as unknown as Record<string, unknown>)
				),
				categories: categories.map((r) =>
					alice.record.normalizeCategory(r as unknown as Record<string, unknown>)
				)
			};
		});

		expect((await localItem(alice, raced)).name).toBe('Butter');
		expect(await alice.db.pending_ops.count()).toBe(1);
		expect((await localItem(alice, existing)).name).toBe('Milk');

		// And it still reaches the server on the next drain.
		const { results } = await capturePush(() => alice.push.drainOutbox());
		expect(results.map((r) => r.status)).toEqual(['applied']);
		expect((await serverItems(admin, listId)).map((r) => r.name).sort()).toEqual([
			'Butter',
			'Milk'
		]);
	});

	test('diverged-only repair: an untouched list is not re-pulled', async () => {
		const { admin, alice, bob } = await scenario({ joinBob: false });
		const listA = await createList(alice, 'Alice');
		const listB = await createList(alice, 'Alice');
		await addMembership(admin, listA, bob.account);
		await addMembership(admin, listB, bob.account);
		await alice.cycle.runSyncCycle();
		await bob.cycle.runSyncCycle();

		// Both clients are in sync on both lists.
		expect((await alice.probe()).diverged).toEqual([]);

		// Bob touches only listA.
		await createItem(bob, listA, { name: 'Milk' });
		await bob.push.drainOutbox();

		const before = await alice.probe();
		expect(before.diverged).toEqual([listA]);

		for (const id of before.diverged) await alice.snapshot.reconcileList(id);

		const after = await alice.probe();
		expect(after.diverged).toEqual([]);
		expect(await alice.db.items.where('list').equals(listA).count()).toBe(1);
	});

	test('a swept tombstone is dropped by the id set, without a full snapshot [D-40]', async () => {
		const { admin, alice, bob, listId } = await scenario();
		const kept = await createItem(alice, listId, { name: 'Milk' });
		const swept = await createItem(alice, listId, { name: 'Bread' });
		await alice.push.drainOutbox();
		await deleteItem(alice, listId, swept);
		await alice.push.drainOutbox();
		await bob.cycle.runSyncCycle();

		// Bob queues an edit on the row the sweep is about to take, and a new row.
		await editItem(bob, listId, swept, { note: 'organic' });
		const added = await createItem(bob, listId, { name: 'Butter' });

		// The daily sweep, as the server runs it: the tombstone is hard-deleted,
		// which changes the list's hash but not its max_updated.
		await admin.collection('items').delete(swept);

		const reads: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const at = url.indexOf('/api/sync/snapshot/');
			if (at >= 0) reads.push(url.slice(at));
			return original(input, init);
		};
		try {
			await bob.cycle.runSyncCycle({ push: false });
		} finally {
			globalThis.fetch = original;
		}

		expect(reads).toEqual([`/api/sync/snapshot/${listId}?ids`]);
		expect((await bob.probe()).diverged).toEqual([]);
		const rows = await bob.db.items.where('list').equals(listId).primaryKeys();
		expect(rows.sort()).toEqual([kept, added].sort());
		expect(await bob.db.server_items.get(swept)).toBeUndefined();

		// Both ops stayed queued: the create lands, the edit is told its row is gone.
		expect(await bob.db.pending_ops.count()).toBe(2);
		const { results } = await capturePush(() => bob.push.drainOutbox());
		expect(results.map((r) => `${r.status}:${r.reason ?? ''}`).sort()).toEqual([
			'applied:',
			'denied:row_missing'
		]);
	});

	test('backup envelope round-trips: what export writes, import accepts [D-72]', async () => {
		const admin = await adminClient();
		const alice = await track(await makeClient(await createAccount(admin, 'Alice')));
		const listId = await createList(alice, 'Alice');

		// One item, pushed and hydrated back so both the item and the per-list
		// template categories are in the local Dexie mirror the export reads.
		await createItem(alice, listId, { name: 'Milk', quantity: '2' });
		await alice.push.drainOutbox();
		await alice.cycle.runSyncCycle();

		// Export through the real client code — this is the FRONTEND version const.
		const { buildListBackup } = await import('#lib/actions/list-backup.js');
		const doc = await buildListBackup(listId);

		// Import through the real backend route — this is the GO version const.
		const imported = await alice.pb.send<{ id: string }>('/api/lists/import', {
			method: 'POST',
			body: { backup: doc }
		});

		expect(imported.id).toBeTruthy();
		expect((await serverItems(admin, imported.id)).map((r) => r.name)).toEqual(['Milk']);
	});

	// [D-90] Two quick arrow taps in the category editor: the second swaps the
	// pair back while the first swap is still on the wire. Both must land, in
	// order, so the server and the device end where the second tap put them.
	test('a reorder made while the previous one is in flight lands after it', async () => {
		const { admin, alice, listId } = await scenario();
		const rows = async () =>
			(await alice.db.list_categories.where('list').equals(listId).toArray())
				.filter((c) => c.deleted_at === null && c.slug !== 'other')
				.sort((a, b) => a.sort_order - b.sort_order);
		const before = await rows();
		const [a, b] = before;
		const original = before.map((c) => c.id);
		const swapped = [b.id, a.id, ...original.slice(2)];

		// Hold the first push on the wire until the second swap is queued.
		const original_fetch = globalThis.fetch;
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		let sent!: () => void;
		const onWire = new Promise<void>((r) => (sent = r));
		let first = true;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (first && url.includes('/api/sync/push')) {
				first = false;
				sent();
				const resp = await original_fetch(input, init);
				await held;
				return resp;
			}
			return original_fetch(input, init);
		};
		try {
			await alice.categories.persistReorder(before, swapped);
			const drain1 = alice.push.drainOutbox();
			await onWire;
			await alice.categories.persistReorder(await rows(), original);
			release();
			await drain1;
			const { results } = await capturePush(() => alice.push.drainOutbox());
			expect(results.every((r) => r.status === 'applied')).toBe(true);
		} finally {
			globalThis.fetch = original_fetch;
		}

		expect((await rows()).map((c) => c.id)).toEqual(original);
		const server = await admin
			.collection('list_categories')
			.getFullList({ filter: `list = "${listId}"` });
		const order = (id: string) => server.find((r) => r.id === id)?.sort_order as number;
		expect(order(a.id)).toBe(a.sort_order);
		expect(order(b.id)).toBe(b.sort_order);
		expect(await alice.db.pending_ops.count()).toBe(0);
	});
});
