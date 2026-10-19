// What a sign-out deletes from this device, and what it keeps ([D-55], [D-145],
// [D-148]). ./index.ts's logout() calls wipeLocalAccountData.
import { db, listDataTables, type MetaKey } from '#lib/db.js';
import { invalidateLiveCaches } from '#lib/state/live.js';

/**
 * Whether each `meta` key belongs to the signed-in account (deleted by a
 * sign-out) or to the device (kept). Every key is listed, so a new one does not
 * type-check until it is classified.
 *
 *  - last_synced_at: the account's sync watermark (§8.5).
 *  - memberships_synced_at: memberships pulled at least once ([D-182]); left
 *    behind, the next account's home would call an unpulled device "no lists".
 *  - suppressed_names: account-bound (§6.11), re-pulled on the next sign-in.
 *  - suppressed_pending: its unconfirmed changes ([D-137]), which would
 *    otherwise be delivered to the next account.
 *  - list_order: device-local, but its value is the account's list ids (§9.3).
 *  - sync_health: what this account's sync last saw of the server ([D-296]).
 *  - seed_version: the shipped vocabulary's, the same for every account.
 *  - the rest are device preferences (§9.3, §12.2).
 */
const ACCOUNT_BOUND: Record<Exclude<MetaKey, `invite_token_${string}`>, boolean> = {
	last_synced_at: true,
	memberships_synced_at: true,
	suppressed_names: true,
	suppressed_pending: true,
	list_order: true,
	sync_health: true,
	seed_version: false,
	list_view: false,
	ui_density: false,
	list_row_sort: false,
	history_sort: false,
	list_sort: false,
	locale: false,
	install_prompt_dismissed: false
};
const ACCOUNT_META_KEYS = Object.entries(ACCOUNT_BOUND).flatMap(([key, bound]) =>
	bound ? [key] : []
);

/**
 * The per-list invite-token cache (#lib/actions/invites): the one plaintext
 * copy of a credential that lets anyone join the list, wiped by prefix
 * ([D-148]).
 */
export const INVITE_TOKEN_META_PREFIX = 'invite_token_';

/** The invite-token cache's key for one list. */
export function inviteTokenKey(listId: string): `invite_token_${string}` {
	return `${INVITE_TOKEN_META_PREFIX}${listId}`;
}

/**
 * Drop every trace of the signed-in account's data from this device, or the
 * next account to sign in here inherits it: lists, items, roster nicknames,
 * scanned products and the outbox (`pending_ops` has no account column, so
 * account A's ops would drain under B's token and stick as denied).
 *
 * Deliberately KEPT: the shipped vocabulary (`category_templates`,
 * `item_dictionary`, `seed_version`; §12.2 tier 2), identical for every account
 * and re-seeded only online, and the device preferences in
 * #lib/state/prefs.ts, per-device by §9.3/§12.2.
 */
export async function wipeLocalAccountData(): Promise<void> {
	const tables = listDataTables();
	await db.transaction('rw', [...tables, db.scanned_products, db.meta], async () => {
		await Promise.all([
			...tables.map((table) => table.clear()),
			db.scanned_products.clear(),
			db.meta.bulkDelete(ACCOUNT_META_KEYS),
			db.meta.where('key').startsWith(INVITE_TOKEN_META_PREFIX).delete()
		]);
	});
	// Live stores cache their last value; without this the next account's first
	// read replays the rows just deleted ([D-145]).
	invalidateLiveCaches();
}
