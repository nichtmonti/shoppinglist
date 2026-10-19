// The row the UI reads (§8.2 step 0): the shadow (the last server state, never
// written by a local edit) with the op's `inflight` layer (on the wire) and
// `pending` layer (since) applied. Pure: the one rule for what a row shows.
import type { Item, ListCategory, OpLayer, PendingOp } from '../db';
import { stampMs } from '../time';
import { normalizeRecord } from './record';
import type { SyncCollection } from './types';

export type Row = Item | ListCategory;

/** One layer of a record's edits, as stored (db.ts OpLayer) with its stamps resolved. */
export type Layer = Required<OpLayer>;

/** A record's queued edits, in the two-layer shape. */
export interface LayeredOp {
	collection: SyncCollection;
	record_id: string;
	list_id: string;
	type: 'create' | 'update';
	inflight?: Layer;
	pending: Layer;
}

/** Keys of an op's `changed` that are signals, not columns: `deleted` stamps
 *  deleted_at ([D-45]); `bought: false` rides with an untick that takes a
 *  purchase back, and the server restores the date the tick replaced ([D-26]). */
export function isSignal(field: string): boolean {
	return field === 'deleted' || field === 'bought';
}

function applyLayer(row: Record<string, unknown>, layer: Layer | undefined): void {
	if (!layer) return;
	for (const [field, value] of Object.entries(layer.changed)) {
		if (isSignal(field)) continue; // not a column: its stamp says what shows
		row[field] = value;
	}
	for (const [field, value] of Object.entries(layer.stamps)) row[field] = value;
}

/**
 * What the UI shows for one record, or `undefined` for no row.
 *
 * - no shadow, no op: the record does not exist here;
 * - no shadow, a create: a blank row with the edits — the server does not
 *   have it yet;
 * - no shadow, an update: nothing — the server no longer has the row, and its
 *   push is about to say so (`gone`/`row_missing`);
 * - otherwise the shadow with `inflight`, then `pending`, applied.
 *
 * Pure: inputs are never mutated, and the result is a fresh object.
 */
export function materialize(
	collection: SyncCollection,
	shadow: Row | undefined,
	op: LayeredOp | undefined
): Row | undefined {
	if (!shadow) {
		if (!op || op.type !== 'create') return undefined;
		// A blank row: every column's empty value, as the field contract normalizes it.
		shadow = normalizeRecord(collection, { id: op.record_id, list: op.list_id });
	}
	if (!op) return { ...shadow };
	const row: Record<string, unknown> = { ...shadow };
	applyLayer(row, op.inflight);
	applyLayer(row, op.pending);
	return row as unknown as Row;
}

// The server-stamped columns that belong to an op field: an optimistic
// `checked` shows with its optimistic `checked_at` (and `last_bought_at` when
// the check set one), a `deleted` signal with its `deleted_at`, a scanned
// `barcode` with the photo its lookup returned ([D-266]). Stamps are kept only
// while their field is still in the op — once it has settled, the server's
// stamps are the truth ([D-40], [D-79]).
export const STAMP_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
	checked: ['checked_at', 'last_bought_at'],
	deleted: ['deleted_at'],
	barcode: ['image_url']
};

/** The values every stamp companion has on `row` — the stamps an op stored without them implies. */
export function stampsFromRow(row: Record<string, unknown>): Record<string, unknown> {
	const stamps: Record<string, unknown> = {};
	for (const field of Object.values(STAMP_COMPANIONS).flat()) {
		if (field in row) stamps[field] = row[field];
	}
	return stamps;
}

/** One stored layer as materialize reads it: its stamps only while their field is in it. */
function layer(stored: OpLayer): Layer {
	const companions = new Set(
		Object.keys(stored.changed).flatMap((field) => STAMP_COMPANIONS[field] ?? [])
	);
	const stamps = Object.fromEntries(
		Object.entries(stored.stamps ?? {}).filter(([field]) => companions.has(field))
	);
	return { changed: stored.changed, base: stored.base, stamps };
}

/** A stored op as materialize's layered shape. */
export function asLayered(op: PendingOp): LayeredOp {
	return {
		collection: op.collection,
		record_id: op.record_id,
		list_id: op.list_id,
		type: op.type,
		inflight: op.inflight && layer(op.inflight),
		pending: layer(op)
	};
}

/**
 * A record's ops as one layer. Usually one op; after a `merged` remap there can
 * be two, applied in queue order.
 */
function layeredOf(ops: PendingOp[]): LayeredOp {
	if (ops.length === 1) return asLayered(ops[0]);
	const inOrder = [...ops].sort((a, b) => a.queued_at.localeCompare(b.queued_at)).map(asLayered);
	const fold = (layers: Layer[]): Layer => ({
		// The later edit wins a field, and its stamps with it…
		changed: Object.assign({}, ...layers.map((l) => l.changed)),
		stamps: Object.assign({}, ...layers.map((l) => l.stamps)),
		// …but a base is the server value when the field was FIRST edited.
		base: Object.assign({}, ...[...layers].reverse().map((l) => l.base))
	});
	const inflight = inOrder.flatMap((l) => (l.inflight ? [l.inflight] : []));
	return {
		...inOrder[0],
		type: inOrder.some((l) => l.type === 'create') ? 'create' : 'update',
		inflight: inflight.length > 0 ? fold(inflight) : undefined,
		pending: fold(inOrder.map((l) => l.pending))
	};
}

/** The ops of one collection, grouped by record id, each group in the order given. */
export function groupByRecord(
	ops: Iterable<PendingOp>,
	collection: SyncCollection
): Map<string, PendingOp[]> {
	const byId = new Map<string, PendingOp[]>();
	for (const op of ops) {
		if (op.collection !== collection) continue;
		const group = byId.get(op.record_id);
		if (group) group.push(op);
		else byId.set(op.record_id, [op]);
	}
	return byId;
}

/**
 * Sets an items view row's local `shelf` and `shelf_at` ([D-308]): `open` for
 * the active list, `done` for a checked row (`shelf_at` its check-off in ms,
 * 0 without a usable stamp), `kept` for a removed row the list remembers
 * buying; neither on a removed row never bought, which no screen shows.
 * Mutates and returns `row`.
 */
export function shelve(row: Item): Item {
	delete row.shelf;
	delete row.shelf_at;
	if (row.deleted_at === null) {
		row.shelf = row.checked ? 'done' : 'open';
		row.shelf_at = row.checked ? (stampMs(row.checked_at) ?? 0) : 0;
	} else if (row.last_bought_at !== null) {
		row.shelf = 'kept';
		row.shelf_at = 0;
	}
	return row;
}

/** What a record's row is: its shadow with all of its queued ops on top. */
export function rowOf(collection: SyncCollection, shadow: Row | undefined, ops: PendingOp[]) {
	const row = materialize(collection, shadow, ops.length > 0 ? layeredOf(ops) : undefined);
	return row && collection === 'items' ? shelve(row as Item) : row;
}
