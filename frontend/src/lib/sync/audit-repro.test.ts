// Deterministic reproductions of cross-cutting sync scenarios — each one a
// rule the engine must keep that no single module's tests would see broken:
//
//   W2 [D-40] — a settle adopts only the fields the server adjudicated (push.ts)
//   W4 [D-109] — one session generation owns every async write        (loop/auth)
//   W5 [D-109] — the outbound drain runs under real leadership         (loop.ts)
//   W6 [D-40] — SSE applies inside the transactional inbound contract (sse.ts)
//   W7 [D-28] — an empty membership set purges                        (cycle.ts)
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '#lib/db.js';
import { wipeLocalAccountData } from '#lib/auth/account-data.js';
import { makeItem, makeMembership, putMyList, putSynced, resetDb } from '#lib/test-kit/db.js';
import { createRecord, updateRecord } from '#lib/sync/outbox.js';
import { drainOutbox } from '#lib/sync/push.js';
import { resetReferenceMirrorCheck, runSyncCycle } from '#lib/sync/cycle.js';
import { startSyncLoop } from '#lib/sync/loop.js';
import { applyEvent } from '#lib/sync/sse.js';
import { endSession, resetSessionForTest } from '#lib/auth/session.js';
import type { DigestEntry, PushOp } from '#lib/sync/types.js';

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// A cycle that reaches no network: every fetcher answers empty and the mirror
// check throws (its failure is non-fatal by design, so it does not abort).
const emptyDeps = () => ({
	digestTransport: async () => [],
	mirror: {
		versionTransport: async () => {
			throw new Error('skip reference network');
		}
	}
});

beforeEach(async () => {
	await resetDb();
	resetReferenceMirrorCheck();
	resetSessionForTest();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// --- W5 ------------------------------------------------------------------
// §8.7 promises exactly one drainer across tabs: the pending_ops liveQuery and
// its debounced drain belong inside the requestLeadership callback, or every
// signed-in tab would subscribe and every signed-in tab would push.
//
// The lock here never grants. A follower must send nothing at all.
it('[W5] a tab waiting for the leadership lock sends nothing', async () => {
	const locks = {
		request: vi.fn<(name: string, ...rest: unknown[]) => Promise<void>>(
			() => new Promise<void>(() => {})
		)
	};
	vi.stubGlobal('navigator', { locks });
	const row = makeItem({ id: 'follower-item', list: 'list-a', name: 'Milk' });
	await createRecord('items', row.list, row.id, { name: row.name });
	const transport = vi.fn(async (ops: PushOp[]) => ({
		results: ops.map((op) => ({
			op_id: op.op_id,
			status: 'applied' as const,
			record: { ...row }
		}))
	}));
	const digestTransport = vi.fn(async () => []);
	const stop = startSyncLoop({ ...emptyDeps(), digestTransport, drain: { transport } });
	try {
		// Comfortably past the 500ms drain debounce.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		// Only the leadership request counts: every tab also holds the shared
		// visibility lock while on screen ([D-164]), which grants no work.
		expect(locks.request.mock.calls.filter(([name]) => name === 'sync-leader')).toHaveLength(1);
		expect(transport).not.toHaveBeenCalled();
		// The leader-only half never ran either — one lock, one answer.
		expect(digestTransport).not.toHaveBeenCalled();
		// And the work is not lost: it waits for whoever holds the lock.
		expect(await db.pending_ops.count()).toBe(1);
	} finally {
		stop();
	}
});

// --- W7 ------------------------------------------------------------------
// A user who loses their only membership gets a legitimately empty membership
// set. No later `gone` verdict rescues the list — the server answers
// denied/not_member first — so the valid empty set itself must purge it
// ([D-28]).
it('[W7] loss of the final membership purges the list', async () => {
	const row = makeItem({ id: 'removed-item', list: 'removed-list', name: 'Milk', quantity: '1' });
	await putSynced([row]);
	await putMyList(row.list, 'Old household', { updated: row.updated });
	await updateRecord('items', row, { quantity: '2' });
	const result = await runSyncCycle({
		...emptyDeps(),
		drain: {
			transport: async (ops) => ({
				results: ops.map((op) => ({ op_id: op.op_id, status: 'denied', reason: 'not_member' }))
			})
		}
	});
	expect(result.purged).toEqual([row.list]);
	expect(await db.memberships.count()).toBe(0);
	expect(await db.items.count()).toBe(0);
	expect(await db.pending_ops.count()).toBe(0);
});

// The other half of [D-28]: a response that is not the API's data (an SPA
// index.html answered with 200 and parsed into nothing) must NOT be read as
// "zero memberships". It is caught by shape, so at any length, and it aborts
// the cycle instead of purging.
it('[W7] a malformed memberships response aborts the cycle instead of purging', async () => {
	const row = makeItem({ id: 'kept-item', list: 'kept-list', name: 'Milk' });
	await putSynced([row]);
	await putMyList(row.list, 'Household');

	// A digest whose memberships are not membership data. The list is NOT in
	// this response, so only the shape check keeps it from being purged.
	await expect(
		runSyncCycle({
			...emptyDeps(),
			digestTransport: async () =>
				[
					{
						list_id: 'other',
						row_count: 0,
						max_updated: '',
						hash: '',
						name: '',
						membership: { nonsense: true }
					}
				] as never
		})
	).rejects.toThrow(/not membership data/);

	// Nothing purged; the mirror stays readable offline.
	expect(await db.memberships.count()).toBe(1);
	expect(await db.items.count()).toBe(1);
});

// --- W2 ------------------------------------------------------------------
// First-committed-wins must not turn into last-writer-wins. B's quantity is
// REJECTED (the server holds 3, the §8.4 notice fires) while an unrelated
// note edit coalesces into the op mid-flight.
//
// Were the settle to re-base EVERY field — the adjudicated quantity included —
// against the returned record, it would requeue "2 against base 3", and the
// next drain would overwrite the winner with a well-formed update the server
// has no reason to refuse ([D-40]). Only `note` (the post-send edit) stays
// queued, and the row takes the server's quantity.
it('[W2] a note edit mid-flight keeps only the note pending; the rejected quantity settles', async () => {
	const row = makeItem({ id: 'conflict-item', list: 'list-a', name: 'Milk', quantity: '1' });
	await putSynced([row]);
	await updateRecord('items', row, { quantity: '2' });
	const conflict = vi.fn();
	await drainOutbox({
		onConflict: conflict,
		transport: async (ops) => {
			const current = (await db.items.get(row.id))!;
			await updateRecord('items', current, { note: 'organic' });
			return {
				results: [
					{
						op_id: ops[0].op_id,
						status: 'partial',
						record: { ...row, quantity: '3', updated: '2026-09-16 10:00:00.000Z' },
						conflicts: [{ field: 'quantity', mine: '2', theirs: '3', theirs_by: 'other-member' }]
					}
				]
			};
		}
	});
	const pending = (await db.pending_ops.toArray())[0];
	// The rejected quantity is GONE from the op — it was adjudicated.
	expect(pending.changed).toEqual({ note: 'organic' });
	expect(pending.base).not.toHaveProperty('quantity');
	// …and the row shows the winner, not the loser.
	expect((await db.items.get(row.id))?.quantity).toBe('3');
	expect((await db.items.get(row.id))?.note).toBe('organic');
	expect(conflict).toHaveBeenCalledTimes(1);
});

// A re-edit made while its field is in flight builds on the in-flight value
// ([D-40]). Made back to the exact value being sent, it still counts as
// pending: comparing it with the sent one would read it as "untouched" and
// drop it. Whether it stands depends on the in-flight value: the server
// refused that one (another member's 3 was first), so the re-edit keeps the
// base the refusal was against and is refused in turn, with its own notice,
// instead of being re-based onto the 3 and silently replacing it.
it('[W2] a re-edit on a value the server refused is refused too', async () => {
	const row = makeItem({ id: 'reedit-item', list: 'list-a', name: 'Milk', quantity: '1' });
	await putSynced([row]);
	await updateRecord('items', row, { quantity: '2' });
	await drainOutbox({
		transport: async (ops) => {
			const current = (await db.items.get(row.id))!;
			// Same value the push is carrying, re-asserted after it went out.
			await updateRecord('items', current, { quantity: '2' });
			return {
				results: [
					{
						op_id: ops[0].op_id,
						status: 'partial',
						record: { ...row, quantity: '3', updated: '2026-09-16 10:00:00.000Z' },
						conflicts: [{ field: 'quantity', mine: '2', theirs: '3', theirs_by: 'other-member' }]
					}
				]
			};
		}
	});
	const pending = (await db.pending_ops.toArray())[0];
	expect(pending.changed).toEqual({ quantity: '2' });
	// Still against 1, which the server no longer holds: the next push conflicts.
	expect(pending.base.quantity).toBe('1');
});

// …while a re-edit on the person's own value that the server took is a newer
// edit of it, re-based onto the record so it applies.
it('[W2] a re-edit on a value the server took is re-based onto it', async () => {
	const row = makeItem({ id: 'reedit-ok', list: 'list-a', name: 'Milk', quantity: '1' });
	await putSynced([row]);
	await updateRecord('items', row, { quantity: '2' });
	await drainOutbox({
		transport: async (ops) => {
			const current = (await db.items.get(row.id))!;
			await updateRecord('items', current, { quantity: '5' });
			return {
				results: [
					{
						op_id: ops[0].op_id,
						status: 'applied',
						record: { ...row, quantity: '2', updated: '2026-09-16 10:00:00.000Z' }
					}
				]
			};
		}
	});
	const pending = (await db.pending_ops.toArray())[0];
	expect(pending.changed).toEqual({ quantity: '5' });
	expect(pending.base.quantity).toBe('2');
});

// --- W4 ------------------------------------------------------------------
// The cycle performs several awaited round-trips with a write after each, so
// the session is checked before every write, not once at entry: a digest
// response (the memberships ride on it) held across a completed
// wipeLocalAccountData() must not land and re-populate the signed-out
// account's rows after sign-out reported itself done.
//
// The order here is logout()'s own: end the session FIRST, then wipe.
it('[W4] a held response cannot write back after the session ends and the wipe completes', async () => {
	const fetched = deferred();
	const response = deferred<DigestEntry[]>();
	const membership = makeMembership({ list: 'account-a-list' });
	const cycle = runSyncCycle({
		...emptyDeps(),
		digestTransport: async () => {
			fetched.resolve();
			return response.promise;
		}
	});
	await fetched.promise;

	endSession();
	await wipeLocalAccountData();
	expect(await db.memberships.count()).toBe(0);

	// The response the ended session asked for finally arrives.
	response.resolve([
		{ list_id: membership.list, row_count: 0, max_updated: '', hash: '', name: '', membership }
	]);
	await cycle;

	expect(await db.memberships.count()).toBe(0);
	expect(await db.memberships.get(membership.id)).toBeUndefined();
});

// The same rule for the repair pull: the cycle checks the session between its
// steps, but a snapshot (or delta) response is written INSIDE the reconcile
// step, so it has to check at its own write. Otherwise the previous account's
// rows for a diverged list would land in the wiped database — orphaned under a
// list no membership names, so nothing would ever purge them.
it('[W4] a snapshot response arriving after the session ends writes nothing', async () => {
	const fetched = deferred();
	const response = deferred<{ items: ReturnType<typeof makeItem>[]; categories: [] }>();
	const membership = makeMembership({ list: 'account-a-list' });
	const cycle = runSyncCycle({
		...emptyDeps(),
		digestTransport: async () => [
			{
				list_id: membership.list,
				row_count: 1,
				max_updated: '2026-01-01 00:00:00.000Z',
				hash: 'server-hash',
				name: 'Account A list',
				membership
			}
		],
		snapshotFetcher: async () => {
			fetched.resolve();
			return response.promise;
		}
	});
	await fetched.promise;

	endSession();
	await wipeLocalAccountData();

	response.resolve({
		items: [makeItem({ id: 'a-private', list: membership.list, name: 'Account A item' })],
		categories: []
	});
	await cycle;

	expect(await db.items.count()).toBe(0);
	// The list row (and its name) came in before the reconcile and went with the wipe.
	expect(await db.lists.count()).toBe(0);
});

// The same rule on the outbound side: a push response that outlives its
// session must not settle rows into whatever account holds the database next.
it('[W4] a push response arriving after the session ends settles nothing', async () => {
	const row = makeItem({ id: 'late-settle', list: 'list-a', name: 'Milk', quantity: '1' });
	await putSynced([row]);
	await updateRecord('items', row, { quantity: '2' });

	const summary = await drainOutbox({
		transport: async (ops) => {
			// The user signs out while the push is in flight.
			endSession();
			return {
				results: [
					{
						op_id: ops[0].op_id,
						status: 'applied',
						record: { ...row, quantity: '2', updated: 'srv-1' }
					}
				]
			};
		}
	});

	// The op is neither settled nor dropped — it is left for the next session
	// to decide, exactly as a transport failure would leave it.
	expect(summary.drained).toBe(0);
	expect(await db.pending_ops.count()).toBe(1);
	expect((await db.items.get(row.id))?.updated).not.toBe('srv-1');
});

// --- W6 ------------------------------------------------------------------
// Every inbound path reads the ops and writes the row in one transaction, SSE
// included: were its read and write separate IndexedDB transactions, a local
// edit could commit in between and the inbound put would revert the value on
// screen while the edit sat queued (the row would end on the server's 9).
//
// Driven as a real race rather than with a paused put: pausing INSIDE the
// transaction would break Dexie's transaction zone, and the test would observe
// the same outcome whatever the code does.
it('[W6] a local edit racing an inbound event is never reverted on screen', async () => {
	const row = makeItem({ id: 'sse-item', list: 'list-a', name: 'Milk', quantity: '1' });
	await putSynced([row]);

	const event = applyEvent('items', { ...row, quantity: '9', updated: 'server-event' }, 'update');
	const edit = updateRecord('items', row, { quantity: '2' });
	await Promise.all([event, edit]);

	// Whichever order Dexie serialized them in, the outcome is the same: if the
	// event landed first the edit wrote over it; if the edit landed first the
	// row is the event's shadow with the queued edit on top. Never the server's
	// value on screen while the user's sits queued behind it.
	expect((await db.items.get(row.id))?.quantity).toBe('2');
	expect((await db.pending_ops.toArray())[0].changed.quantity).toBe('2');
});
