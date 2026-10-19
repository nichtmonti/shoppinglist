// Real-backend reproductions of push-path scenarios that only this layer can
// see, because each turns on what the Go push endpoint actually commits, not
// on what a mocked transport was told to return:
//
//   W2 [D-40] — a settle adopts only the fields the server adjudicated (push.ts)
//   W3 [D-108] — a duplicate-name merge is retry-safe and keeps a check-off (push.go)
//   W7 [D-28] — losing one's final membership purges the cached list (cycle.ts)
import { afterEach, expect, it } from 'vitest';
import {
	addMembership,
	adminClient,
	createAccount,
	createList,
	makeClient,
	newId,
	removeMembership,
	serverItem,
	type Client
} from '../harness';

const clients: Client[] = [];
afterEach(() => {
	while (clients.length) clients.pop()?.close();
});

// Two members of one list, both converged on a single 'Milk' row.
async function fixture() {
	const admin = await adminClient();
	const a = await makeClient(await createAccount(admin, 'AuditA'));
	const b = await makeClient(await createAccount(admin, 'AuditB'));
	clients.push(a, b);
	const list = await createList(a);
	await addMembership(admin, list, b.account);
	await a.cycle.runSyncCycle();
	await b.cycle.runSyncCycle();
	const id = newId();
	await a.outbox.createRecord('items', list, id, { name: 'Milk', quantity: '1', checked: false });
	await a.push.drainOutbox();
	await b.cycle.runSyncCycle();
	return { admin, a, b, list, id };
}

async function edit(c: Client, list: string, id: string, changed: Record<string, unknown>) {
	await c.outbox.updateRecord('items', (await c.db.items.get(id))!, changed);
}

// --- W2 ------------------------------------------------------------------
// The §8.4 conflict callback fires AND the advertised winner survives.
//
// B's quantity loses to A's 3 while an unrelated note edit lands mid-flight.
// Were B's rejected quantity re-based onto the winning 3, the NEXT drain would
// present base 3 / value 2 — which the server accepts, correctly, as a
// well-formed update. The read that matters is therefore the one AFTER the
// second drain; the intermediate state looks fine either way.
it('REAL REPRO [W2]: a mid-flight note edit does not overwrite the winning value', async () => {
	const { admin, a, b, list, id } = await fixture();
	await edit(a, list, id, { quantity: '3' });
	await edit(b, list, id, { quantity: '2' });
	await a.push.drainOutbox();
	const notices: unknown[] = [];
	await b.push.drainOutbox({
		onConflict: (n) => notices.push(n),
		transport: async (ops) => {
			const response = await b.pb.send('/api/sync/push', { method: 'POST', body: { ops } });
			await edit(b, list, id, { note: 'organic' });
			return response;
		}
	});
	expect((await serverItem(admin, id)).quantity).toBe('3');
	expect(notices).toHaveLength(1);
	// The second drain carries the note and ONLY the note.
	await b.push.drainOutbox();
	const settled = await serverItem(admin, id);
	expect(settled.quantity).toBe('3');
	expect(settled.note).toBe('organic');
	expect(await b.db.pending_ops.count()).toBe(0);
});

// --- W3(a) ---------------------------------------------------------------
// [D-42]'s duplicate-record_id replay check looks up the op's OWN record id,
// which can only match a create that became a ROW. A create that became a
// MERGE has its id discarded, so a retry after a lost response would look like
// a brand-new create: the merge would run a second time and its re-activation
// un-check a purchase another member made in between. merge_log recognises the
// id and answers from it ([D-108]).
it('REAL REPRO [W3]: retrying a duplicate-name create after a lost response leaves the check-off standing', async () => {
	const { admin, a, b, list, id } = await fixture();
	const duplicate = newId();
	await b.outbox.createRecord('items', list, duplicate, {
		name: 'Milk',
		quantity: '1',
		checked: false
	});
	// Committed server-side, then the response never reaches B.
	const first = await b.push.drainOutbox({
		transport: async (ops) => {
			await b.pb.send('/api/sync/push', { method: 'POST', body: { ops } });
			throw new Error('response lost after commit');
		}
	});
	expect(first.failed).toBe(1);
	await a.cycle.runSyncCycle();
	await edit(a, list, id, { checked: true });
	await a.push.drainOutbox();
	expect((await serverItem(admin, id)).checked).toBe(true);
	// The retry replays as the same merge instead of re-activating.
	await b.push.drainOutbox();
	expect((await serverItem(admin, id)).checked).toBe(true);
	// …and still converges: B ends up pointing at the survivor, not a second row.
	expect(await b.db.pending_ops.count()).toBe(0);
	expect(await b.db.items.get(duplicate)).toBeUndefined();
});

// --- W3(b) ---------------------------------------------------------------
// The other half: an offline create-then-check coalesces `checked: true` into
// the create. If the merge's re-activation won over it, the purchase would be
// dropped with an empty outbox and NO notice — nothing the user could notice
// or recover. The caller's own post-create intent outranks re-activation.
it('REAL REPRO [W3]: add and check while offline keeps the check through a duplicate-name merge', async () => {
	const { admin, b, list, id } = await fixture();
	const duplicate = newId();
	await b.outbox.createRecord('items', list, duplicate, {
		name: 'Milk',
		quantity: '1',
		checked: false
	});
	await edit(b, list, duplicate, { checked: true });
	const notices: unknown[] = [];
	await b.push.drainOutbox({ onConflict: (n) => notices.push(n) });
	const merged = await serverItem(admin, id);
	expect(merged.checked).toBe(true);
	// The stamps ride along with it ([D-79]): a checked row with no checked_at
	// reads as long-since-bought and would skip the §9.1 recently-checked section.
	expect(merged.checked_at).toBeTruthy();
	expect(merged.last_bought_at).toBeTruthy();
	// No conflict to report — the caller's value won outright.
	expect(notices).toHaveLength(0);
	expect(await b.db.pending_ops.count()).toBe(0);
});

// --- W7 ------------------------------------------------------------------
// Against the real server's real answers: membership genuinely revoked, server
// legitimately returns zero memberships, queued op denied not_member. The list
// must be purged by the membership set — an empty set is authoritative
// ([D-28]) — since no `gone` verdict ever comes: the server answers
// denied/not_member first.
it('REAL REPRO [W7]: removal of a final membership purges the cached list', async () => {
	const { admin, b, list, id } = await fixture();
	await removeMembership(admin, list, b.account);
	await edit(b, list, id, { quantity: '9' });
	await b.cycle.runSyncCycle();
	expect(await b.db.memberships.count()).toBe(0);
	expect(await b.db.items.get(id)).toBeUndefined();
	expect(await b.db.pending_ops.count()).toBe(0);
	expect(await b.db.lists.get(list)).toBeUndefined();
});
