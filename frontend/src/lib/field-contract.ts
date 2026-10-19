// The client half of the §8.3 field contract: the same JSON the Go side embeds,
// imported rather than restated so the two cannot drift. Vite bundles it at
// build time (backend/ is inside the default `server.fs.allow` in dev).
import contract from '../../../backend/internal/fieldcontract/field-contract.json';
import type { SyncCollection } from '#lib/sync/index.js';

interface FieldSpec {
	max_bytes?: number;
	/** The JSON type the push route accepts; text when absent. */
	type?: 'bool' | 'number';
}

interface BackupSpec {
	format: string;
	version: number;
	max_categories: number;
	max_items: number;
}

interface Contract {
	max_items_per_list: number;
	max_ops_per_push: number;
	server_stamped: string[];
	backup: BackupSpec;
	collections: Record<string, { writable: Record<string, FieldSpec> }>;
	denied_reasons: string[];
	push_statuses: string[];
	list_limit: { status: number; code: string };
	demo_lifetime_hours: number;
	palette: string[];
	row_shape: Record<string, string[]>;
}

const c = contract as unknown as Contract;

/**
 * Every collection the contract caps: `SyncCollection` plus the collections
 * written by server routes, which must never be reachable from the outbox. The
 * cap lookups take this wider type so route-written inputs (list name,
 * nickname) are capped from the same numbers ([D-08]).
 */
export type ContractCollection = SyncCollection | 'lists' | 'accounts' | 'credentials';

/** The rows a list may hold by default, tombstones included ([D-217]). */
export const MAX_ITEMS_PER_LIST: number = c.max_items_per_list;

/** The maximum ops one §8.3 push may carry; the drain chunks to it. */
export const MAX_OPS_PER_PUSH: number = c.max_ops_per_push;

/**
 * Columns the server owns, stripped from every op's changed/base ([D-26],
 * [D-45]); their optimistic values ride in the op's unsent `stamps`.
 */
export const SERVER_STAMPED_FIELDS: readonly string[] = c.server_stamped;

/** The [D-72] backup envelope, re-exported by #lib/backup; the import route
 *  validates against the same values ([D-72]). */
export const BACKUP_FORMAT: string = c.backup.format;
export const BACKUP_VERSION: number = c.backup.version;
export const MAX_BACKUP_CATEGORIES: number = c.backup.max_categories;
export const MAX_BACKUP_ITEMS: number = c.backup.max_items;

/**
 * The `denied` reason codes the §8.3 push route can return; pins the
 * hand-written client and Go lists (reasons-contract.test.ts).
 */
export const CONTRACT_DENIED_REASONS: readonly string[] = c.denied_reasons;

/**
 * The per-op statuses a §8.3 push result can carry; pins the hand-written
 * client and Go lists (reasons-contract.test.ts).
 */
export const CONTRACT_PUSH_STATUSES: readonly string[] = c.push_statuses;

/**
 * The [D-219] refusal the list-making routes share: its HTTP status and body
 * code, which the Go handler's tests read from the same file.
 */
export const LIST_LIMIT: Readonly<{ status: number; code: string }> = c.list_limit;

/** How long a demo account lives, counted from its creation ([D-234]). */
export const DEMO_LIFETIME_MS: number = c.demo_lifetime_hours * 60 * 60 * 1000;

/**
 * The curated category color tokens [D-37]. Pins `PALETTE` in #lib/categories,
 * app.css and the seed's colors, where a typo would render gray with no error
 * (categories.test.ts, backend/seed/palette_contract_test.go).
 */
export const CONTRACT_PALETTE: readonly string[] = c.palette;

/**
 * The client-facing row columns per collection. Pins the Go record maps and the
 * normalizers in ./sync/record (reasons-contract.test.ts).
 */
export const CONTRACT_ROW_SHAPE: Readonly<Record<string, readonly string[]>> = c.row_shape;

/**
 * The UTF-8 byte cap for a field, or undefined where none applies. Inputs also
 * use it as `maxlength`, which counts UTF-16 units, so that is only a UX guard
 * against ASCII overrun: a `denied` push result is the backstop.
 */
export function maxBytesFor(collection: ContractCollection, field: string): number | undefined {
	return c.collections[collection]?.writable[field]?.max_bytes;
}

/** UTF-8 byte length — what the server actually measures. */
export function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}
