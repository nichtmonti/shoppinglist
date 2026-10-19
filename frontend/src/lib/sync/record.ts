import type { Item, ListCategory } from '../db';
import type { SyncCollection } from './types';

// Stringify a scalar. Anything non-primitive (an expanded relation object, a JSON field)
// becomes '' rather than the useless "[object Object]" — a garbage id that would silently
// fail every later comparison instead of reading as "absent".
export function scalar(v: unknown): string {
	switch (typeof v) {
		case 'string':
			return v;
		case 'number':
		case 'boolean':
		case 'bigint':
			return String(v);
		default:
			return '';
	}
}

// Coerce a PB value to a string ('' for null/undefined). A relation arrives as a string, a
// single-element array, or (expanded) an object; it takes the same coercion as plain text.
export function str(v: unknown): string {
	if (v == null) return '';
	return Array.isArray(v) ? (v[0] != null ? scalar(v[0]) : '') : scalar(v);
}

// As str, with '' as null.
function strOrNull(v: unknown): string | null {
	const s = str(v);
	return s === '' ? null : s;
}

function bool(v: unknown): boolean {
	return v === true || v === 'true' || v === 1;
}

function num(v: unknown): number {
	return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0;
}

export function normalizeItem(r: Record<string, unknown>): Item {
	return {
		id: str(r.id),
		list: str(r.list),
		name: str(r.name),
		name_de: strOrNull(r.name_de),
		name_en: strOrNull(r.name_en),
		quantity: str(r.quantity),
		note: strOrNull(r.note),
		category_key: strOrNull(r.category_key),
		checked: bool(r.checked),
		checked_at: strOrNull(r.checked_at),
		last_bought_at: strOrNull(r.last_bought_at),
		barcode: strOrNull(r.barcode),
		image_url: strOrNull(r.image_url),
		modified_by: strOrNull(r.modified_by),
		updated: str(r.updated),
		created: str(r.created),
		deleted_at: strOrNull(r.deleted_at)
	};
}

export function normalizeCategory(r: Record<string, unknown>): ListCategory {
	return {
		id: str(r.id),
		list: str(r.list),
		slug: strOrNull(r.slug),
		name: strOrNull(r.name),
		icon: str(r.icon),
		color: str(r.color),
		sort_order: num(r.sort_order),
		updated: str(r.updated),
		created: str(r.created),
		deleted_at: strOrNull(r.deleted_at)
	};
}

// Dispatch by collection.
export function normalizeRecord(
	collection: SyncCollection,
	r: Record<string, unknown>
): Item | ListCategory {
	return collection === 'items' ? normalizeItem(r) : normalizeCategory(r);
}
