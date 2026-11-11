// §7.1 invite lifecycle. Reading invites is a direct SDK call (any member,
// §11); minting and revoking are server routes ([D-31],
// backend/internal/invites/manage.go), the only writers. The server keeps a
// live link's token for every member ([D-294]) and one active link per list.
// The token travels in the URL fragment, so it never reaches access logs or
// Referer headers (§7.1, §10).
import { pb } from '#lib/pb.js';

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

/**
 * The list's current non-revoked, non-expired invite, if any: what the share
 * sheet presents, with its token for any member ([D-294]). Reading never
 * mints: a revoked link stays revoked until a member creates one ([D-330]).
 */
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

/** „Neuer Link“: the server rotates on a mint, in one transaction [D-31]. */
export async function resetInvite(listId: string): Promise<Invite> {
	return createInvite(listId);
}
