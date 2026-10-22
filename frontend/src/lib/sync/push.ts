// The outbox drain (§8.2 step 6, §8.3, §8.4, §8.6).
import { collectionTables, db, shadowTable, type OpLayer, type PendingOp } from '../db';
import { recompute } from './apply';
import { asLayered, isSignal, materialize } from './materialize';
import { anySignal, apiJson } from './http';
import { pendingOpsOrdered } from './outbox';
import { normalizeRecord } from './record';
import { MAX_OPS_PER_PUSH } from '#lib/field-contract.js';
import type { PushOp, PushResult, SyncNotices } from './types';
import { purgeGoneList } from './purge';
import { sessionScope } from '../auth/session';

// A transport sends a batch of ops and returns the server's per-op results.
export type PushTransport = (
	ops: PushOp[],
	signal?: AbortSignal
) => Promise<{ results: PushResult[] }>;

// The real transport: POST /api/sync/push as the signed-in account.
async function defaultTransport(
	ops: PushOp[],
	signal?: AbortSignal
): Promise<{ results: PushResult[] }> {
	return (await apiJson('/api/sync/push', {
		label: 'sync/push',
		method: 'POST',
		body: { ops },
		timeoutMs: 15_000,
		signal
	})) as { results: PushResult[] };
}

export interface DrainOptions extends SyncNotices {
	transport?: PushTransport; // default = defaultTransport (real fetch)
	// Aborted when the drain's owner stops (the loop's stop()): the request in
	// flight is cancelled, no batch goes out after it, and the rest stay queued.
	signal?: AbortSignal;
}

export interface DrainSummary {
	drained: number; // ops that settled (applied/partial/noop/merged/deleted_conflict/denied/gone)
	failed: number; // ops kept because they were not delivered (transport failure, no result)
	// Settled ops that stay queued with edits made while they were in flight. Not a
	// failure: their own write schedules the next drain ([D-139]).
	requeued: number;
	// What stopped the drain, when a send failed: what the status says ([D-296]).
	error?: unknown;
}

// Sends every queued op, oldest first, in batches of at most MAX_OPS_PER_PUSH
// (the server refuses a larger push, §8.3).
export async function drainOutbox(opts: DrainOptions = {}): Promise<DrainSummary> {
	const transport = opts.transport ?? defaultTransport;
	// §5.6 [D-109]: a response after sign-out settles nothing.
	const session = sessionScope();
	// Ends with the session or with the owner, whichever comes first.
	const signal = opts.signal ? anySignal([opts.signal, session.signal]) : session.signal;
	const ops = await pendingOpsOrdered();
	if (ops.length === 0) return { drained: 0, failed: 0, requeued: 0 };

	let drained = 0;
	let failed = 0;
	let requeued = 0;
	// Lists purged by a `gone` in this drain: later results for them are ignored.
	const purged = new Set<string>();
	for (let i = 0; i < ops.length; i += MAX_OPS_PER_PUSH) {
		// Its owner stopped: nothing more is frozen or sent, and the rest stay queued.
		if (signal.aborted) return { drained, failed, requeued };
		const snapshot = ops.slice(i, i + MAX_OPS_PER_PUSH);

		// Freeze each op's payload (db.ts PendingOp): a layer already in flight is
		// resent unchanged, else the pending edits become it. Re-read, since an op
		// can have changed since the opening snapshot.
		const batch = await db.transaction('rw', db.pending_ops, async () => {
			const fresh: (PendingOp & { inflight: OpLayer })[] = [];
			const frozen: PendingOp[] = [];
			for (const current of await db.pending_ops.bulkGet(snapshot.map((op) => op.op_id))) {
				if (!current) continue; // settled or dropped since the snapshot
				if (!current.inflight) {
					if (Object.keys(current.changed).length === 0) continue; // nothing to send
					const { changed, base, stamps } = current;
					current.inflight = { changed, base, stamps };
					current.changed = {};
					current.base = {};
					current.stamps = {};
					frozen.push(current);
				}
				fresh.push(current as PendingOp & { inflight: OpLayer });
			}
			await db.pending_ops.bulkPut(frozen);
			return fresh;
		});
		if (batch.length === 0) continue;

		const wireOps: PushOp[] = batch.map((o) => ({
			op_id: o.op_id,
			collection: o.collection,
			record_id: o.record_id,
			list_id: o.list_id,
			type: o.type,
			changed: o.inflight.changed,
			base: o.inflight.base,
			queued_at: o.queued_at
		}));

		let resp: { results: PushResult[] };
		try {
			resp = await transport(wireOps, signal);
		} catch (error) {
			// Cancelled by its owner: not a failure, and the ops stay queued.
			if (signal.aborted) return { drained, failed, requeued };
			// A failed send keeps this batch and the rest, in order, for the retry.
			return { drained, failed: failed + (ops.length - i), requeued, error };
		}

		const byId = new Map(resp.results.map((r) => [r.op_id, r]));
		for (const [j, op] of batch.entries()) {
			// Per result: a sign-out can land between two settles.
			if (!session.owned()) {
				return { drained, failed: failed + (ops.length - i - j), requeued };
			}
			if (purged.has(op.list_id)) {
				drained++;
				continue;
			}
			const result = byId.get(op.op_id);
			if (!result) {
				// No result: the server failed on this op. It stays queued.
				failed++;
				continue;
			}
			await applyResult(op, result, { ...opts, signal });
			if (result.status === 'gone') purged.add(op.list_id);
			// An op edited mid-flight keeps its pending layer, queued for the next push (keepPending).
			if (await db.pending_ops.get(op.op_id)) requeued++;
			else drained++;
		}
	}
	return { drained, failed, requeued };
}

async function applyResult(op: PendingOp, result: PushResult, opts: DrainOptions): Promise<void> {
	switch (result.status) {
		case 'applied':
		case 'partial':
		case 'noop':
		case 'deleted_conflict': {
			await settleAndDrop(op, result);
			// Conflicts only surface on partial/deleted_conflict (the losing statuses).
			if (
				result.conflicts?.length &&
				(result.status === 'partial' || result.status === 'deleted_conflict')
			) {
				opts.onConflict?.({
					kind: result.status,
					collection: op.collection,
					record_id: op.record_id,
					conflicts: result.conflicts
				});
			}
			break;
		}
		case 'merged': {
			const survivorId = result.record_id!;
			const deadId = op.record_id;

			await db.transaction('rw', collectionTables(op.collection), async () => {
				// Settle onto the survivor: a pending layer is re-based and re-pointed at
				// it (§8.2 step 6).
				await settleRecord(op, result.record!, survivorId);

				// Remap any other queued ops from deadId → survivorId.
				await db.pending_ops
					.where('record_id')
					.equals(deadId)
					.filter((o) => o.op_id !== op.op_id && o.collection === op.collection)
					.modify({ record_id: survivorId });

				// The dead id has no server row and no op left, so recompute removes it.
				await shadowTable(op.collection).delete(deadId);
				await recompute(op.collection, [survivorId, deadId]);
			});

			if (result.conflicts?.length) {
				opts.onConflict?.({
					kind: 'merged',
					collection: op.collection,
					record_id: survivorId,
					conflicts: result.conflicts
				});
			}
			break;
		}
		case 'denied': {
			// Terminal: drop what was refused and say why ([D-40]).
			await dropDenied(op);
			opts.onDenied?.({
				collection: op.collection,
				record_id: op.record_id,
				list_id: op.list_id,
				reason: result.reason,
				field: result.field
			});
			break;
		}
		case 'gone':
			// §8.6 cleanup: wipe the list's local data + all its ops.
			await purgeGoneList(op.list_id, opts.onGone, () => !opts.signal?.aborted);
			break;
	}
}

/**
 * Drop the in-flight layer the server refused; the pending layer was never
 * refused and stays queued. A denied create goes whole, since the row exists
 * nowhere else.
 */
async function dropDenied(sent: PendingOp): Promise<void> {
	await db.transaction('rw', collectionTables(sent.collection), async () => {
		const current = await db.pending_ops.get(sent.op_id);
		if (current) {
			if (current.type === 'create') await db.pending_ops.delete(current.op_id);
			else await keepPending(current, {});
		}
		await recompute(sent.collection, [sent.record_id]);
	});
}

// Helper for settling statuses: the record becomes the row's shadow, the
// in-flight layer is done, and any pending edits stay queued against it.
async function settleAndDrop(op: PendingOp, result: PushResult): Promise<void> {
	await db.transaction('rw', collectionTables(op.collection), async () => {
		let record = result.record;
		if (!record) {
			// A settle without a record: guess the shadow with the payload applied, marked
			// unknown so the digest repairs it ([D-40]).
			const [shadow, current] = await Promise.all([
				shadowTable(op.collection).get(op.record_id),
				db.pending_ops.get(op.op_id)
			]);
			const guess = materialize(op.collection, shadow, {
				...asLayered(current ?? op),
				pending: { changed: {}, base: {}, stamps: {} }
			});
			record = guess ? { ...guess, updated: '' } : undefined;
		}
		if (record) await settleRecord(op, record, op.record_id);
		else await db.pending_ops.delete(op.op_id);
		await recompute(op.collection, [op.record_id]);
	});
}

// Shared settle body — must run inside a transaction over collectionTables. The
// record becomes the shadow under `recordId` (the survivor, on `merged`); the
// in-flight layer is done, and the op keeps only its pending edits, re-pointed
// at `recordId`. The caller recomputes.
async function settleRecord(
	sent: PendingOp,
	record: Record<string, unknown>,
	recordId: string
): Promise<void> {
	await shadowTable(sent.collection).put({
		...normalizeRecord(sent.collection, record),
		id: recordId
	});
	const current = await db.pending_ops.get(sent.op_id);
	if (current) await keepPending({ ...current, record_id: recordId, type: 'update' }, record);
}

/**
 * The op after its in-flight layer is done: its pending edits, or nothing. A
 * pending field whose in-flight value the server took, or with no base yet,
 * is re-based onto the settled `record`; other bases stand, so a re-edit built
 * on a value the server refused (a lost conflict) is refused too ([D-40]). A
 * denial passes `{}`.
 */
async function keepPending(op: PendingOp, record: Record<string, unknown>): Promise<void> {
	const { inflight, ...rest } = op;
	const fields = Object.keys(rest.changed);
	if (fields.length === 0) {
		await db.pending_ops.delete(op.op_id);
		return;
	}
	const base = { ...rest.base };
	for (const field of fields) {
		if (isSignal(field) || !(field in record)) continue; // a signal / nothing settled
		const took =
			inflight && field in inflight.changed && same(record[field], inflight.changed[field]);
		if (took || !(field in base)) {
			base[field] = record[field] ?? null;
		}
	}
	await db.pending_ops.put({ ...rest, base });
}

/** One field value as the record and an op carry it: null and '' alike. */
function same(a: unknown, b: unknown): boolean {
	return (a ?? '') === (b ?? '');
}
