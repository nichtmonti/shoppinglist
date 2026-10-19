// §7.1 invite lifecycle. Reading invites is a direct SDK call (any member,
// §11); minting and revoking are server routes ([D-31],
// backend/internal/invites/manage.go), the only writers. The server keeps a
// live link's token for every member ([D-294]) and one active link per list.
// The token travels in the URL fragment, so it never reaches access logs or
// Referer headers (§7.1, §10).
import { getMeta, setMeta } from '#lib/db.js';
import { inviteTokenKey } from '#lib/auth/account-data.js';
import { pb } from '#lib/pb.js';
import { sessionScope } from '#lib/auth/session.js';

export interface Invite {
	id: string;
	list: string;
	expires_at: string;
	revoked: boolean;
	/** The live link's token; absent for one minted before [D-294]. */
	token?: string;
}

/** The share URL: the token rides in the fragment (§7.1). */
export function inviteUrl(token: string): string {
	const origin = globalThis.location?.origin ?? '';
	return `${origin}/join#${token}`;
}

/** Pull a token back out of a pasted URL or accept a bare token. */
export function tokenFromInput(input: string): string {
	const trimmed = input.trim();
	const hash = trimmed.indexOf('#');
	return hash >= 0 ? trimmed.slice(hash + 1) : trimmed;
}

/** The list's current non-revoked, non-expired invite, if any. */
export async function activeInvite(listId: string): Promise<Invite | null> {
	const rows = await pb.collection('invites').getFullList({
		filter: pb.filter('list = {:list} && revoked = false', { list: listId }),
		sort: '-created'
	});
	const now = Date.now();
	const live = rows.find((r) => new Date(r.expires_at as string).getTime() > now);
	return live
		? {
				id: live.id,
				list: listId,
				expires_at: live.expires_at as string,
				revoked: false,
				token: (live.token as string | undefined) || undefined
			}
		: null;
}

/** Mint a fresh invite; the raw token is returned this once only. */
export async function createInvite(listId: string): Promise<Invite> {
	const record = await pb.send<{ id: string; expires_at: string; token: string }>(
		`/api/lists/${listId}/invite`,
		{ method: 'POST', body: {} }
	);
	return {
		id: record.id,
		list: listId,
		expires_at: record.expires_at,
		revoked: false,
		token: record.token
	};
}

/**
 * Retire the list's link without evicting members (§7.1). Keyed by list, not
 * invite id: the server revokes whatever is live ([D-31]).
 */
export async function revokeInvite(listId: string): Promise<void> {
	await pb.send(`/api/lists/${listId}/invite/revoke`, { method: 'POST', body: {} });
}

/** "Link zurücksetzen": the server rotates on a mint, in one transaction [D-31]. */
export async function resetInvite(listId: string): Promise<Invite> {
	return createInvite(listId);
}

// ---- what the share sheet shows ---------------------------------------------

/**
 * The invite the share sheet presents: the list's active one, with its token
 * for any member ([D-294]), or null when the list has none. Opening the sheet
 * never mints: a revoked link stays revoked until a member creates one ([D-330]).
 */
export async function currentInvite(listId: string): Promise<Invite | null> {
	const active = await activeInvite(listId);
	if (!active || active.token) return active;
	const cached = await cachedInviteToken(listId, active.id);
	return cached ? { ...active, token: cached } : active;
}

/**
 * "Link zurücksetzen" and "Link erstellen" as the share sheet runs them:
 * rotate, and remember the new token.
 */
export async function rotateInvite(listId: string): Promise<Invite> {
	// A mint answering after sign-out must not cache its token for the next
	// account ([D-148], §5.6 [D-109]).
	const session = sessionScope();
	const invite = await resetInvite(listId);
	if (session.owned()) await cacheInviteToken(listId, invite);
	return invite;
}

// ---- the invite-token cache ------------------------------------------------
// A link minted before [D-294] has no token on the server, so the device that
// minted it keeps showing it from here, pinned to the invite's id so a
// rotation elsewhere is not offered a stale one. Cleared on sign-out
// ([D-148]). Goes once those links have expired (30 days, §7.1).

/** Remembers the token of an invite this device just minted. */
export async function cacheInviteToken(listId: string, invite: Invite): Promise<void> {
	if (!invite.token) return;
	await setMeta(inviteTokenKey(listId), { id: invite.id, token: invite.token });
}

/** The cached token for `inviteId` on this list, or null if this device never minted it. */
export async function cachedInviteToken(listId: string, inviteId: string): Promise<string | null> {
	const cached = await getMeta(inviteTokenKey(listId));
	return cached && cached.id === inviteId ? cached.token : null;
}
