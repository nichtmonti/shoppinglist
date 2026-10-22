// Wire types that mirror backend/internal/sync Go structs, and the notices the
// engine raises from them.
import type { Membership } from '#lib/db.js';

/** The two collections the §8.3 push route moves — every other one is server-managed. */
export const SYNC_COLLECTIONS = ['items', 'list_categories'] as const;
export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];

// A conflict entry is §8.4 toast copy only — the server already decided first-committed-wins.
export interface ConflictEntry {
	field: string;
	mine?: unknown;
	theirs?: unknown;
	theirs_by?: string;
}

// The per-op statuses, pinned to the Go side by reasons-contract.test.ts and
// reason_codes_test.go.
export const PUSH_STATUSES = [
	'applied',
	'partial',
	'noop',
	'merged',
	'denied',
	'gone',
	'deleted_conflict'
] as const;

type PushStatus = (typeof PUSH_STATUSES)[number];

// The `denied` reason codes, pinned to the Go side by reasons-contract.test.ts
// and reason_codes_test.go. A newer server may send one this build does not
// know, so consumers fall through to the generic message (formatDenied).
export const DENIED_REASONS = [
	'bad_collection',
	'bad_list',
	'bad_type',
	'field_unknown',
	'field_invalid',
	'field_too_long',
	'not_member',
	'wrong_list',
	'protected_row',
	'bad_record_id',
	'row_missing',
	'list_full'
] as const;

type DeniedReason = (typeof DENIED_REASONS)[number];

// A single push result. `record` is the authoritative current server row, present on
// every SETTLING status (applied/partial/noop/merged/deleted_conflict), omitted on gone+denied.
// `record_id` is present on `merged` (the surviving row's id).
// `reason`/`field` are present on `denied` only.
export interface PushResult {
	op_id: string;
	status: PushStatus;
	conflicts?: ConflictEntry[];
	record_id?: string;
	record?: Record<string, unknown>;
	reason?: DeniedReason;
	field?: string;
}

// Conflict notice (raw data for the §8.4 toast; #lib/state/sync-notices formats the text).
export interface ConflictNotice {
	kind: 'partial' | 'deleted_conflict' | 'merged';
	collection: SyncCollection;
	record_id: string; // the client's record id (for merged: the SURVIVOR id — the dead
	// row is deleted by the settle before this notice is emitted, so the formatter
	// must not be handed an id that no longer resolves)
	conflicts: ConflictEntry[]; // raw {field, mine, theirs, theirs_by} toast copy
}

// A terminal refusal: the refused part was dropped and the row shows the server's
// state again. An absent or unknown `reason` reads as the generic case.
export interface DeniedNotice {
	collection: SyncCollection;
	record_id: string;
	list_id: string;
	reason?: string;
	field?: string;
}

/** What the engine tells the user about: the app binds these to toasts (mountSync). */
export interface SyncNotices {
	onConflict?: (notice: ConflictNotice) => void; // §8.4 toast
	// §8.6 "list vanished" notice, from a push's `gone` or the cycle's purge.
	// `name` is the list's name, read BEFORE the purge deletes the list row it lives on.
	onGone?: (listId: string, name?: string) => void;
	onDenied?: (notice: DeniedNotice) => void; // terminal refusal — dropped, tell the user
}

// The outbound op shape sent to POST /api/sync/push.
export interface PushOp {
	op_id: string;
	collection: SyncCollection;
	record_id: string;
	list_id: string;
	type: 'create' | 'update';
	changed?: Record<string, unknown>;
	base?: Record<string, unknown>;
	queued_at?: string;
}

// GET /api/sync/digest response entry.
export interface DigestEntry {
	list_id: string;
	row_count: number;
	max_updated: string;
	hash: string;
	// The list's name, the same for every member ([D-08]).
	name: string;
	// The caller's own membership row for this list ([D-28]): the entries are the
	// authoritative membership set the vanished-list purge compares against.
	membership: Membership;
}
