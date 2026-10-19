// List lifecycle: the transactional routes of §7.5 / §7.6 and the two direct-PB
// writes of §11 (rename, leave). None of this rides the outbox, so all of it is
// online-only ([D-09], §9.3): lists are set up online, shopping works offline.
import { db, ownMembership } from '#lib/db.js';
import { pb } from '#lib/pb.js';
import { applyServerPatch, pullFromServer, purgeList, refreshRoster } from '#lib/sync/index.js';
import { parseListBackup, type BackupCategory, type ListBackup } from '#lib/backup.js';
import { buildListBackup } from '#lib/actions/list-backup.js';
import { deliverBackup } from '#lib/deliver-backup.js';
import { sessionScope } from '#lib/auth/session.js';
import { ClientResponseError } from 'pocketbase';
import { t } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';
import { httpStatus } from '#lib/http-status.js';
import { LIST_LIMIT } from '#lib/field-contract.js';

/**
 * [D-219] The server refused a new list: the account is already on `max`
 * lists. Its message is the user's copy, so the create and clone dialogs show
 * it as is (LocalizedError) and the import toast reads `max` off it.
 */
export class ListLimitError extends LocalizedError {
	constructor(readonly max: number) {
		super(t('home_list_limit', { max }));
	}
}

/**
 * POST one of the three routes that make a list (create, clone, import) and
 * return the server-minted id ([D-08]). The 409 they share for the [D-219] cap
 * becomes a ListLimitError; any other failure is rethrown unchanged.
 *
 * The inline cycle pulls the new list in before the caller navigates to it,
 * where AddBar's auto-categorisation needs its categories. It is best-effort:
 * the list exists once the POST returns, so a failed cycle must not reject
 * (the home would show an error and stay put); the ambient loop (§8.5)
 * repairs it.
 */
async function postNewList(path: string, body: object): Promise<string> {
	try {
		const { id } = await pb.send<{ id: string }>(path, { method: 'POST', body });
		await pullFromServer();
		return id;
	} catch (e) {
		const res =
			e instanceof ClientResponseError ? (e.response as { code?: unknown; max?: unknown }) : null;
		if (
			e instanceof ClientResponseError &&
			e.status === LIST_LIMIT.status &&
			res?.code === LIST_LIMIT.code
		) {
			throw new ListLimitError(typeof res.max === 'number' ? res.max : 0);
		}
		throw e;
	}
}

export interface ListPreview {
	name: string;
	items: { name: string; name_de: string | null; name_en: string | null; quantity: string }[];
	member_count: number;
}

/**
 * §7.5 `POST /api/lists`: the list, the creator's membership and its copy of
 * the category seed, in one transaction. Returns the server-minted id ([D-08]).
 */
export function createList(name: string): Promise<string> {
	return postNewList('/api/lists', { name });
}

/** §7.6 `POST /api/invites/preview` — unauthenticated, read-only snapshot. */
export async function previewInvite(token: string): Promise<ListPreview> {
	return pb.send('/api/invites/preview', { method: 'POST', body: { token } });
}

/**
 * §7.6 `POST /api/invites/join`, idempotent for an existing member. The inline
 * cycle hydrates the joined list ([D-28] [D-40]) before the caller navigates
 * to it; without it the route's `known` check, which reads the local
 * `memberships` mirror, would say the list does not exist. Best-effort, as in
 * createList.
 */
export async function joinList(token: string): Promise<string> {
	const membership = await pb.send<{ id: string; list: string }>('/api/invites/join', {
		method: 'POST',
		body: { token }
	});
	await pullFromServer();
	// §7.4 trigger (a): the member line would otherwise say "just you" until the
	// next cycle. Not awaited, so a slow roster does not hold the join.
	void refreshRoster(membership.list).catch(() => {});
	return membership.list;
}

/**
 * §7.2 leave = hard-delete your own membership row (the §7.3 last-one-out
 * cascade fires server-side), then the §8.6 purge, which also drops the list's
 * queued ops.
 */
export async function leaveList(listId: string): Promise<void> {
	const own = await ownMembership(listId);
	const membershipId = own?.id ?? (await findOwnMembershipId(listId));
	if (membershipId) {
		// A retry after a lost response finds the membership already gone: the
		// leave happened, so it purges like the first try would have ([D-293]).
		await pb
			.collection('memberships')
			.delete(membershipId)
			.catch((e: unknown) => {
				if (httpStatus(e) !== 404) throw e;
			});
	}
	await purgeList(listId);
}

async function findOwnMembershipId(listId: string): Promise<string | null> {
	const rows = await pb.collection('memberships').getFullList({
		filter: pb.filter('list = {:list}', { list: listId })
	});
	return rows[0]?.id ?? null;
}

/**
 * §6.4 / §9.3: the list's one name ([D-08]), renamed by any member with a
 * direct-PB update, never a sync op. A sign-out while the update is in flight
 * discards its echo, so the wiped row is not rewritten ([D-109]).
 */
export async function renameList(listId: string, name: string): Promise<void> {
	const session = sessionScope();
	await pb.collection('lists').update(listId, { name });
	if (!session.owned()) return;
	await db.lists.update(listId, { name });
}
/**
 * [D-72] `POST /api/lists/{listId}/clone`: the server copies the live
 * categories and items into a fresh list ([D-72]). The server holds no UI
 * text, so the name is always the client's.
 */
export function cloneList(listId: string, name: string): Promise<string> {
	return postNewList(`/api/lists/${listId}/clone`, { name });
}

/**
 * [D-72] `POST /api/lists/import`: a new list from a parsed backup, never a
 * merge into an existing one. The server refuses a blank name.
 */
export function importList(backup: ListBackup, name: string): Promise<string> {
	return postNewList('/api/lists/import', { name, backup });
}

/**
 * The categories `POST /api/lists` gives a new list, as a backup's rows: every
 * template not retired ([D-300]), keyed by slug. A session just started may
 * not have mirrored the templates yet, so an empty mirror pulls first.
 */
export async function templateCategories(): Promise<BackupCategory[]> {
	if ((await db.category_templates.count()) === 0) await pullFromServer();
	return (await db.category_templates.toArray())
		.filter((tpl) => !tpl.retired)
		.sort((a, b) => a.sort_order - b.sort_order)
		.map((tpl) => ({
			key: tpl.slug,
			slug: tpl.slug,
			name: null,
			icon: tpl.icon,
			color: tpl.color,
			sort_order: tpl.sort_order
		}));
}

export type ImportOutcome =
	| { ok: true; id: string }
	| { ok: false; reason: 'invalid' | 'failed' }
	// [D-217] more items than one list may hold here.
	| { ok: false; reason: 'too_many_items'; max: number; count: number }
	// [D-219] the account is at its lists cap.
	| { ok: false; reason: 'list_limit'; max: number };

/** What the import screen says about a failed `outcome`. */
export function importFailureMessage(outcome: Extract<ImportOutcome, { ok: false }>): string {
	switch (outcome.reason) {
		case 'too_many_items':
			return t('home_import_too_many_items', { max: outcome.max, count: outcome.count });
		case 'list_limit':
			return t('home_list_limit', { max: outcome.max });
		case 'invalid':
			return t('home_import_invalid');
		case 'failed':
			return t('home_import_failed');
	}
}

/**
 * Import a backup file the user picked, under the file's list name or
 * `fallbackName`. `invalid` is not a usable backup; `failed` is a valid file
 * the server did not import.
 */
export async function importListFromFile(
	file: Pick<Blob, 'text'>,
	fallbackName: string
): Promise<ImportOutcome> {
	let backup: ListBackup;
	try {
		const parsed = parseListBackup(JSON.parse(await file.text()));
		if (!parsed.ok) {
			if (parsed.reason === 'too_many_items') {
				return { ok: false, reason: 'too_many_items', max: parsed.max, count: parsed.count };
			}
			return { ok: false, reason: 'invalid' };
		}
		backup = parsed.value;
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	return importBackup(backup, backup.display_name.trim() || fallbackName);
}

/**
 * Create a list from a backup the app built itself — a pasted or shared text
 * list ([D-254]) — under `name`. The same outcomes as a picked file, minus
 * `invalid`: the document is ours.
 */
export async function importBackup(
	backup: ListBackup,
	name: string
): Promise<Exclude<ImportOutcome, { reason: 'invalid' | 'too_many_items' }>> {
	try {
		const id = await importList(backup, name);
		return { ok: true, id };
	} catch (e) {
		if (e instanceof ListLimitError) return { ok: false, reason: 'list_limit', max: e.max };
		return { ok: false, reason: 'failed' };
	}
}

/**
 * [D-72] Export from the local mirror, so it works offline. Resolves false when
 * the user dismissed the share sheet.
 */
export async function exportList(listId: string): Promise<boolean> {
	const backup = await buildListBackup(listId);
	return deliverBackup(backup);
}

/**
 * [D-79] `POST /api/lists/{listId}/clear-history`: clears every purchase date of
 * the list's items. Resolves the count for the toast.
 */
export async function clearHistory(listId: string): Promise<number> {
	const { cleared } = await pb.send<{ cleared: number }>(`/api/lists/${listId}/clear-history`, {
		method: 'POST'
	});
	// Into the shadows, never an op: the rows are recomputed ([D-40]), so a
	// check-off still queued keeps its optimistic stamps until its push settles.
	await applyServerPatch('items', listId, { checked_at: null, last_bought_at: null });
	return cleared;
}
