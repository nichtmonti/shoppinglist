import { db, rosterKey, type RosterEntry } from '../db';
import { apiJson } from './http';
import { sessionScope } from '../auth/session';

export interface RosterMember {
	account: string;
	nickname: string;
	joined: string; // ISO string from the roster route
}

export type RosterTransport = (listId: string) => Promise<RosterMember[]>;

async function defaultRosterTransport(listId: string): Promise<RosterMember[]> {
	return (await apiJson(`/api/lists/${encodeURIComponent(listId)}/members`, {
		label: 'roster',
		// A conflict toast waits on this lookup (nicknameFor), so it must not hang.
		timeoutMs: 10_000
	})) as RosterMember[];
}

// Refresh the cached roster for a list: replace all of this list's roster entries with the
// server's current member set. Returns the members.
export async function refreshRoster(
	listId: string,
	transport: RosterTransport = defaultRosterTransport
): Promise<RosterMember[]> {
	const session = sessionScope();
	const members = await transport(listId);
	// The roster names co-members of a list the PREVIOUS account belonged to
	// (§5.6 [D-109]); a response arriving after sign-out must not re-seed it.
	if (!session.owned()) return members;
	await db.transaction('rw', db.roster, async () => {
		await db.roster.where('list').equals(listId).delete();
		await db.roster.bulkPut(
			members.map((m): RosterEntry => ({
				id: rosterKey(listId, m.account),
				list: listId,
				account: m.account,
				nickname: m.nickname,
				joined: m.joined
			}))
		);
	});
	return members;
}
