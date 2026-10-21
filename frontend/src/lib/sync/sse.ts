import { collectionTables, db, shadowTable } from '../db';
import type { SyncCollection } from './types';
import { applyServerRows, forgetServerRows } from './apply';
import { str } from './record';
import { pb } from '../pb';
import type { RecordSubscription } from 'pocketbase';
import { sessionScope } from '../auth/session';

// Apply one PB realtime event (create/update/delete): the record becomes the
// row's shadow — or, deleted, stops being one — and the row is recomputed from
// it and whatever is queued (sync/apply.ts). An event older than the shadow
// (sent before a push this device has had answered since) is dropped: every
// write moves a row's `updated` forward (§8.5), and an older row as the shadow
// would hand the next edit a base the server left behind. This is the
// unit-testable core; subscribe() (below) wires the PB SDK subscription to it.
//
// ONE TRANSACTION over the collection's tables ([D-40]): a local edit
// committing between the op read and the row write would otherwise be
// reverted on screen while it sits queued.
export async function applyEvent(
	collection: SyncCollection,
	record: Record<string, unknown>,
	eventType: 'create' | 'update' | 'delete'
): Promise<void> {
	// An event for the account that was signed in when this subscription opened
	// must not land after sign-out (§5.6 [D-109]).
	const session = sessionScope();

	await db.transaction('rw', collectionTables(collection), async () => {
		if (!session.owned()) return;
		if (eventType === 'delete') return forgetServerRows(collection, [String(record.id)]);
		const shadow = await shadowTable(collection).get(String(record.id));
		if (shadow && shadow.updated > str(record.updated)) return;
		await applyServerRows(collection, [record]);
	});
}

// The list id an event's record belongs to, through record.ts's coercion.
function recordListId(record: unknown): string {
	return str((record as Record<string, unknown>).list);
}

// Subscribe to PB realtime for a list's items + list_categories (mount.ts binds it
// to the list on screen) and return the unsubscribe. The list filter is evaluated
// SERVER-SIDE: a `filter` on the subscription makes PocketBase evaluate
// `list = {:listId}` per subscriber per event before anything is sent (v0.39.9
// apis/realtime.go realtimeCanAccessRecord, a SQL EXISTS against the collection),
// so a member's connection does not receive events for their other lists.
//
// Delete events are covered by the same check: v0.39 materializes the delete
// broadcast through a dry-cache hook that runs BEFORE the delete commits, with
// the row still present in the DB specifically so rule/filter evaluation sees
// it (the comment at apis/realtime.go:464-467 exists for exactly this).
//
// The client-side recordListId comparison below stays as a second line of
// defense: if the server filter ever silently stopped applying (SDK drift, a
// server upgrade changing semantics), events from other lists would still be
// discarded rather than applied to the wrong list. The digest probe remains the authority either way ([D-28] SSE
// policy) — a freshness regression can never become a correctness one.
export async function subscribe(listId: string): Promise<() => Promise<void>> {
	const filter = pb.filter('list = {:listId}', { listId });
	const onEvent = (collection: SyncCollection) => (e: RecordSubscription) => {
		if (recordListId(e.record) === listId) {
			void applyEvent(collection, e.record, e.action as 'create' | 'update' | 'delete');
		}
	};
	const unsubItems = await pb.collection('items').subscribe('*', onEvent('items'), { filter });
	let unsubCats: () => Promise<void>;
	try {
		unsubCats = await pb
			.collection('list_categories')
			.subscribe('*', onEvent('list_categories'), { filter });
	} catch (error) {
		// The caller only ever sees the rejection, never `unsubItems`, and its retry
		// (mount.ts setActiveList) subscribes afresh — so the half that did succeed
		// has to be taken down here, or every retry stacks another items listener.
		await unsubItems().catch(() => {});
		throw error;
	}
	return async () => {
		await unsubItems();
		await unsubCats();
	};
}
