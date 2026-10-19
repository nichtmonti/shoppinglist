// Per-list backup documents ([D-72]): the fields a human cares about
// plus the checked state, and nothing the sync engine owns (no ids,
// modified_by or server timestamps), so the file round-trips byte-for-byte
// through parseListBackup. One document version, no compatibility path.
//
// The envelope constants and byte caps come from ./field-contract, the JSON the
// Go import route embeds too.
import {
	byteLength,
	maxBytesFor,
	BACKUP_FORMAT,
	BACKUP_VERSION,
	MAX_BACKUP_CATEGORIES
} from './field-contract';
import type { SyncCollection } from '#lib/sync/index.js';
import { foldUmlauts } from './fold-umlauts';
import { IMPORT_MAX_ITEMS } from './config';
import { stampMs } from './time';

export {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	MAX_BACKUP_CATEGORIES,
	MAX_BACKUP_ITEMS
} from './field-contract';

export interface BackupCategory {
	key: string; // file-local join key: "c0", "c1", …
	slug: string | null;
	name: string | null;
	icon: string;
	color: string;
	sort_order: number;
}

export interface BackupItem {
	name: string;
	// A scanned item's localized names ([D-21]), written only when set, so
	// files exported before they existed still parse.
	name_de?: string;
	name_en?: string;
	quantity: string;
	note: string | null;
	category_key: string | null; // references BackupCategory.key
	barcode: string | null;
	image_url: string | null;
	// [D-72] `checked` is always present after parsing (absent means false);
	// the stamps only when the row carries them.
	checked: boolean;
	checked_at?: string;
	last_bought_at?: string;
}

export interface ListBackup {
	format: string;
	version: number;
	exported_at: string; // ISO timestamp
	display_name: string; // the list's name (the key predates [D-08]'s one name per list)
	categories: BackupCategory[];
	items: BackupItem[];
}

type BackupParseResult =
	| { ok: true; value: ListBackup }
	| {
			ok: false;
			reason:
				'format' | 'version' | 'shape' | 'too_many_categories' | 'oversize' | 'dangling_category';
	  }
	// The one refusal a user can act on, so it carries the numbers ([D-217]).
	| { ok: false; reason: 'too_many_items'; max: number; count: number };

/** A backup document stamped now, around a list's name and rows. */
export function backupDocument(
	name: string,
	categories: BackupCategory[],
	items: BackupItem[]
): ListBackup {
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exported_at: new Date().toISOString(),
		display_name: name,
		categories,
		items
	};
}

/** What one field of a backup row may hold. `nullable` must be present and
 *  may be null; `optional` may be absent but not null. A `stamp` is a string
 *  that parses as a date ([D-72]). `capped` checks the contract's byte cap. */
interface FieldRule {
	type: 'string' | 'number' | 'boolean' | 'stamp';
	presence?: 'nullable' | 'optional';
	capped?: true;
}

const CATEGORY_FIELDS: Record<keyof BackupCategory, FieldRule> = {
	key: { type: 'string' },
	// `slug` is not capped: it is server-owned, and the import route accepts
	// only template slugs, each once ([D-08]). The contract must not list it
	// under `writable`, which would make it pushable (§8.3).
	slug: { type: 'string', presence: 'nullable' },
	name: { type: 'string', presence: 'nullable', capped: true },
	icon: { type: 'string', capped: true },
	color: { type: 'string', capped: true },
	sort_order: { type: 'number' }
};

const ITEM_FIELDS: Record<keyof BackupItem, FieldRule> = {
	name: { type: 'string', capped: true },
	name_de: { type: 'string', presence: 'optional', capped: true },
	name_en: { type: 'string', presence: 'optional', capped: true },
	quantity: { type: 'string', capped: true },
	note: { type: 'string', presence: 'nullable', capped: true },
	category_key: { type: 'string', presence: 'nullable' },
	barcode: { type: 'string', presence: 'nullable', capped: true },
	image_url: { type: 'string', presence: 'nullable', capped: true },
	// Absent means "never ticked", as in the import route: the two sides must
	// agree, or a file one accepts the other rejects.
	checked: { type: 'boolean', presence: 'optional' },
	checked_at: { type: 'stamp', presence: 'optional' },
	last_bought_at: { type: 'stamp', presence: 'optional' }
};

function fits(value: unknown, rule: FieldRule): boolean {
	if (value === null) return rule.presence === 'nullable';
	if (value === undefined) return rule.presence === 'optional';
	if (rule.type === 'stamp') return typeof value === 'string' && stampMs(value) !== null;
	return typeof value === rule.type;
}

/** A row's fault against its field table, a wrong shape before an oversized
 *  value; null for a row that passes. */
function rowFault(
	raw: unknown,
	fields: Record<string, FieldRule>,
	collection: SyncCollection
): 'shape' | 'oversize' | null {
	if (typeof raw !== 'object' || raw === null) return 'shape';
	const row = raw as Record<string, unknown>;
	let fault: 'oversize' | null = null;
	for (const [field, rule] of Object.entries(fields)) {
		const value = row[field];
		if (!fits(value, rule)) return 'shape';
		if (rule.capped && typeof value === 'string') {
			const cap = maxBytesFor(collection, field);
			if (cap !== undefined && byteLength(value) > cap) fault = 'oversize';
		}
	}
	return fault;
}

/** An item row that passed its field table: `checked` may still be absent. */
type CheckedItem = Omit<BackupItem, 'checked'> & { checked?: boolean };

/**
 * Parse and validate a backup file. Total over `unknown`; success rebuilds the
 * value field by field, so extra fields in the file are dropped. A file with
 * several faults reports the first of: shape, too many rows, oversize,
 * dangling category.
 */
export function parseListBackup(
	data: unknown,
	maxItems: number = IMPORT_MAX_ITEMS
): BackupParseResult {
	if (typeof data !== 'object' || data === null) return { ok: false, reason: 'format' };
	const obj = data as Record<string, unknown>;

	if (obj.format !== BACKUP_FORMAT) return { ok: false, reason: 'format' };
	if (obj.version !== BACKUP_VERSION) return { ok: false, reason: 'version' };

	if (!Array.isArray(obj.categories) || !Array.isArray(obj.items)) {
		return { ok: false, reason: 'shape' };
	}
	if (typeof obj.exported_at !== 'string' || typeof obj.display_name !== 'string') {
		return { ok: false, reason: 'shape' };
	}

	let oversize = false;
	for (const raw of obj.categories) {
		const fault = rowFault(raw, CATEGORY_FIELDS, 'list_categories');
		if (fault === 'shape') return { ok: false, reason: 'shape' };
		oversize ||= fault === 'oversize';
	}
	for (const raw of obj.items) {
		const fault = rowFault(raw, ITEM_FIELDS, 'items');
		if (fault === 'shape') return { ok: false, reason: 'shape' };
		// checked_at needs checked ([D-26]).
		const item = raw as CheckedItem;
		if (item.checked_at !== undefined && item.checked !== true) {
			return { ok: false, reason: 'shape' };
		}
		oversize ||= fault === 'oversize';
	}
	const rawCategories = obj.categories as BackupCategory[];
	const rawItems = obj.items as CheckedItem[];

	if (rawCategories.length > MAX_BACKUP_CATEGORIES) {
		return { ok: false, reason: 'too_many_categories' };
	}
	if (rawItems.length > maxItems) {
		return { ok: false, reason: 'too_many_items', max: maxItems, count: rawItems.length };
	}
	if (oversize) return { ok: false, reason: 'oversize' };

	const categoryKeys = new Set(rawCategories.map((cat) => cat.key));
	if (rawItems.some((item) => item.category_key !== null && !categoryKeys.has(item.category_key))) {
		return { ok: false, reason: 'dangling_category' };
	}

	const categories: BackupCategory[] = rawCategories.map((cat) => ({
		key: cat.key,
		slug: cat.slug,
		name: cat.name,
		icon: cat.icon,
		color: cat.color,
		sort_order: cat.sort_order
	}));

	const items: BackupItem[] = rawItems.map((item) => ({
		name: item.name,
		...(item.name_de ? { name_de: item.name_de } : {}),
		...(item.name_en ? { name_en: item.name_en } : {}),
		quantity: item.quantity,
		note: item.note,
		category_key: item.category_key,
		barcode: item.barcode,
		image_url: item.image_url,
		checked: item.checked === true,
		...(item.checked_at !== undefined ? { checked_at: item.checked_at } : {}),
		...(item.last_bought_at !== undefined ? { last_bought_at: item.last_bought_at } : {})
	}));

	return {
		ok: true,
		value: {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: obj.exported_at,
			display_name: obj.display_name,
			categories,
			items
		}
	};
}

/**
 * Filename for a backup: the name lowercased with umlauts folded (foldUmlauts,
 * not `#lib/normalize.js`), `[a-z0-9]+` runs joined by `-` (empty: `liste`),
 * then `-{YYYY-MM-DD}.json`.
 */
export function backupFileName(displayName: string, exportedAt: Date): string {
	const slug = foldUmlauts(displayName.toLowerCase())
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	// The day where the file is made: at 00:30 in Berlin the UTC date is yesterday's.
	const pad = (n: number) => String(n).padStart(2, '0');
	const date = `${exportedAt.getFullYear()}-${pad(exportedAt.getMonth() + 1)}-${pad(exportedAt.getDate())}`;
	return `${slug || 'liste'}-${date}.json`;
}
