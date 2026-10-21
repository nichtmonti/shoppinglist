// The user-facing copy of the sync engine's notices (§8.4 conflict, §8.3
// denial, §8.6 list gone), raised as passive toasts. The engine reports raw
// data; the root layout hands these handlers to mountSync, and the loop runs
// in the leader tab only, so each notice also goes to the other tabs ([D-293]).
import { reportUncaught } from '#lib/client-errors.js';
import { db, rosterKey, type Item } from '#lib/db.js';
import { displayName } from '#lib/item-name.js';
import {
	querySyncedRow,
	refreshRoster,
	scalar,
	type ConflictNotice,
	type DeniedNotice,
	type SyncNotices
} from '#lib/sync/index.js';
import { showNotice } from '#lib/toasts.js';
import { t, type MessageKey } from '#lib/i18n/index.js';
import { memberName } from '#lib/member-name.js';
import { categoryName } from '#lib/categories.js';

const FIELD_KEYS: Record<string, MessageKey> = {
	quantity: 'sync_field_quantity',
	name: 'sync_field_name',
	note: 'sync_field_note',
	category_key: 'sync_field_category_key',
	checked: 'sync_field_checked'
};

/**
 * The roster nickname for an account id, with §7.4's on-miss trigger (c): one
 * roster refresh, then "someone", which is also right for a deleted account
 * ([D-32]).
 */
export async function nicknameFor(listId: string, accountId: string | undefined): Promise<string> {
	if (!accountId) return t('common_someone');
	const cached = await db.roster.get(rosterKey(listId, accountId));
	if (cached) return memberName(cached.nickname);
	try {
		await refreshRoster(listId);
	} catch {
		/* offline — fall through to the generic name */
	}
	const refreshed = await db.roster.get(rosterKey(listId, accountId));
	return refreshed ? memberName(refreshed.nickname) : t('common_someone');
}

// Which conflict a one-liner shows: the quantity's first (the merged copy
// speaks of a quantity), the aisle's last (a re-add always reports one).
const FIELD_ORDER = ['quantity', 'name', 'note', 'checked', 'category_key'];

/**
 * The value that stands, as the user knows it: a category by its name, not
 * its row id, and a tick in words. '' for a cleared value.
 */
async function theirsText(field: string, theirs: unknown): Promise<string> {
	if (field === 'checked' && typeof theirs === 'boolean') {
		return t(theirs ? 'sync_value_checked' : 'sync_value_unchecked');
	}
	if (field === 'category_key' && typeof theirs === 'string' && theirs) {
		const category = await db.list_categories.get(theirs);
		if (category) {
			const templates = new Map(
				(await db.category_templates.toArray()).map((tpl) => [tpl.slug, tpl] as const)
			);
			return categoryName(category, templates) || scalar(theirs);
		}
	}
	return scalar(theirs);
}

/**
 * Render a conflict notice as one interpolated message (§12.2, no
 * concatenation). §8.4 wants a one-liner, so one entry is shown (FIELD_ORDER).
 */
export async function formatConflict(notice: ConflictNotice): Promise<string> {
	const rank = (field: string) => {
		const i = FIELD_ORDER.indexOf(field);
		return i < 0 ? FIELD_ORDER.length : i;
	};
	const first = [...notice.conflicts].sort((a, b) => rank(a.field) - rank(b.field))[0];
	// Read the row from its own collection: a conflict may name a category.
	const row = await querySyncedRow(notice.collection, notice.record_id);
	const listId = row?.list ?? '';
	// An item reads in this viewer's language ([D-21]); a category by its name.
	const rowName =
		notice.collection === 'items' && row ? displayName(row as Item) : (row?.name ?? '');
	const who = await nicknameFor(listId, first?.theirs_by);

	if (notice.kind === 'deleted_conflict') {
		return t('sync_conflict_deleted', { name: rowName });
	}
	// A blank never stands against a create's quantity since [D-29] fills it;
	// should one come anyway, it reads as cleared, never as „“.
	if (notice.kind === 'merged' && first?.field === 'quantity' && scalar(first.theirs)) {
		return t('sync_conflict_merged', { name: rowName, who, theirs: scalar(first.theirs) });
	}
	const fieldKey = FIELD_KEYS[first?.field ?? ''] ?? 'sync_field_generic';
	const theirs = first ? await theirsText(first.field, first.theirs) : '';
	// Named, so one of several notices says which row it is about ([D-293]).
	const field = t(fieldKey);
	if (!theirs) {
		return rowName
			? t('sync_conflict_cleared_named', { name: rowName, who, field })
			: t('sync_conflict_cleared', { who, field });
	}
	return rowName
		? t('sync_conflict_field_named', { name: rowName, who, field, theirs })
		: t('sync_conflict_field', { who, field, theirs });
}

// The other tabs of this app: the notice is raised where the user is looking,
// which may not be the leader ([D-293]).
const otherTabs = new BroadcastChannel('sync-notices');
otherTabs.onmessage = (event: MessageEvent<string>) => showNotice(event.data);

function raise(message: string): void {
	showNotice(message);
	otherTabs.postMessage(message);
}

async function surfaceConflict(notice: ConflictNotice): Promise<void> {
	// A merge that discarded nothing shows nothing [D-29].
	if (notice.conflicts.length === 0) return;
	raise(await formatConflict(notice));
}

/**
 * A terminal refusal (§8.3 `denied`), already dropped by the engine, as a
 * passive notice. `field_too_long` names the field: `maxlength` counts UTF-16
 * units and the server UTF-8 bytes, so umlauts and emoji can still reach it.
 * Rare reasons collapse into one generic line rather than a wire code.
 */
export function formatDenied(notice: DeniedNotice): string {
	if (notice.reason === 'field_too_long' && notice.field) {
		const fieldKey = FIELD_KEYS[notice.field] ?? 'sync_field_generic';
		return t('sync_denied_too_long', { field: t(fieldKey) });
	}
	if (notice.reason === 'protected_row') return t('sync_denied_protected');
	// [D-217] Rare, but a member who hits it can act on it.
	if (notice.reason === 'list_full') {
		return t(
			notice.collection === 'list_categories'
				? 'sync_denied_categories_full'
				: 'sync_denied_list_full'
		);
	}
	return t('sync_denied_generic');
}

/**
 * §8.6 / §7.3: one line, no undo. Neutral on purpose ([D-138]): the client
 * cannot tell a deleted list from one left on another device.
 */
export function formatGone(name: string | undefined): string {
	return name ? t('sync_list_gone', { name }) : t('sync_list_gone_unknown');
}

/** The loop's notice callbacks: each notice as a passive toast. */
export const noticeToasts: SyncNotices = {
	// A notice that cannot be worded is still reported: the user's edit was
	// overridden either way.
	onConflict: (notice) =>
		void surfaceConflict(notice).catch((e) => reportUncaught(e, 'conflict notice')),
	onGone: (_listId, name) => raise(formatGone(name)),
	// A lost membership raises the §8.6 notice from the next cycle instead
	// ([D-138]).
	onDenied: (notice) => {
		if (notice.reason !== 'not_member') raise(formatDenied(notice));
	}
};
