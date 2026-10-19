// #lib/actions/invites.ts — §7.1. Minting and revoking are server routes
// ([D-31]), so what these tests pin is the CALL, not a local ceremony: the
// client does not generate the token, hash it, or sequence a revoke-then-create.
// "One active link per list" is the server's invariant (one transaction behind
// a partial unique index), which is why resetInvite is a plain mint.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pbSend, invitesGetFullList, pbFilter } = vi.hoisted(() => ({
	pbSend: vi.fn(),
	invitesGetFullList: vi.fn().mockResolvedValue([]),
	pbFilter: vi.fn((expr: string) => expr)
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		collections: { invites: { getFullList: invitesGetFullList } },
		send: pbSend,
		pb: { filter: pbFilter }
	});
});

import {
	activeInvite,
	cacheInviteToken,
	cachedInviteToken,
	createInvite,
	currentInvite,
	resetInvite,
	revokeInvite,
	rotateInvite,
	tokenFromInput
} from './invites';
import { db } from '#lib/db.js';
import { endSession, resetSessionForTest } from '#lib/auth/session.js';
import { INVITE_TOKEN_META_PREFIX } from '#lib/auth/account-data.js';

const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

beforeEach(() => {
	vi.clearAllMocks();
	invitesGetFullList.mockResolvedValue([]);
	pbSend.mockResolvedValue({
		id: 'inv-new',
		expires_at: future,
		token: 'server-minted-token'
	});
});

describe('revokeInvite (§7.1, [D-31])', () => {
	it('calls the list-scoped revoke route and touches nothing else', async () => {
		await revokeInvite('list-1');

		// Keyed by LIST, not invite id: the list has one active link and the
		// server revokes whatever is live. Revoking must not evict current
		// members — it is one call against the invite, never a membership write.
		expect(pbSend).toHaveBeenCalledTimes(1);
		expect(pbSend).toHaveBeenCalledWith('/api/lists/list-1/invite/revoke', {
			method: 'POST',
			body: {}
		});
	});
});

describe('resetInvite ([D-31])', () => {
	it('is a single mint call — the server rotates atomically', async () => {
		const created = await resetInvite('list-1');

		// One request, not revoke-then-create: two unsynchronised requests could
		// leave a list with no link at all, or two live ones.
		expect(pbSend).toHaveBeenCalledTimes(1);
		expect(pbSend).toHaveBeenCalledWith('/api/lists/list-1/invite', {
			method: 'POST',
			body: {}
		});
		expect(created.token).toBe('server-minted-token');
	});
});

describe('createInvite (§7.1, §10, [D-31])', () => {
	it('sends no token material and returns the server-minted token', async () => {
		const invite = await createInvite('list-1');

		const [path, opts] = pbSend.mock.calls[0] as [string, { body: Record<string, unknown> }];
		expect(path).toBe('/api/lists/list-1/invite');
		// The client chooses NONE of this: not the token, not its hash, not
		// created_by, not the expiry — and ([D-08]) not a name either:
		// the joiner sees the list's one name.
		expect(opts.body).toEqual({});
		expect(invite.token).toBe('server-minted-token');
		expect(invite.list).toBe('list-1');
		expect(invite.revoked).toBe(false);
	});
});

describe('activeInvite', () => {
	it('ignores expired rows and returns the newest live one', async () => {
		invitesGetFullList.mockResolvedValueOnce([
			{ id: 'inv-old', expires_at: past },
			{ id: 'inv-live', expires_at: future }
		]);

		expect(await activeInvite('list-1')).toMatchObject({ id: 'inv-live', revoked: false });
	});

	it('returns null when every invite has expired', async () => {
		invitesGetFullList.mockResolvedValueOnce([{ id: 'inv-old', expires_at: past }]);

		expect(await activeInvite('list-1')).toBeNull();
	});
});

describe('tokenFromInput', () => {
	it('accepts a pasted share URL or a bare token (§7.1: token rides the fragment)', () => {
		expect(tokenFromInput('  https://example.org/join#abc-123 ')).toBe('abc-123');
		expect(tokenFromInput('abc-123')).toBe('abc-123');
	});
});

describe('the invite-token cache ([D-148])', () => {
	beforeEach(async () => {
		await db.meta.clear();
	});

	it('offers the token back only for the invite it was minted with', async () => {
		await cacheInviteToken('list1', { id: 'inv1', token: 'tok1', expires_at: future } as never);
		expect(await cachedInviteToken('list1', 'inv1')).toBe('tok1');
		// A reset or a revoke elsewhere mints a new invite: the old token is stale.
		expect(await cachedInviteToken('list1', 'inv2')).toBeNull();
		expect(await cachedInviteToken('list2', 'inv1')).toBeNull();
	});

	it('caches nothing for an invite read back without its token', async () => {
		await cacheInviteToken('list1', { id: 'inv1', token: null, expires_at: future } as never);
		expect(await cachedInviteToken('list1', 'inv1')).toBeNull();
	});
});

describe("the share sheet's invite (currentInvite / rotateInvite)", () => {
	beforeEach(async () => {
		await db.meta.clear();
	});

	// [D-330] Opening the share sheet never mints: a revoked link stays revoked.
	it('is null when the list has no active invite, and mints nothing', async () => {
		expect(await currentInvite('list1')).toBeNull();
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('shows the active invite with the token this device minted for it', async () => {
		invitesGetFullList.mockResolvedValue([{ id: 'inv1', expires_at: future }]);
		await cacheInviteToken('list1', { id: 'inv1', token: 'tok1', expires_at: future } as never);

		expect(await currentInvite('list1')).toMatchObject({ id: 'inv1', token: 'tok1' });
		expect(pbSend).not.toHaveBeenCalled();
	});

	// [D-294] Any member shares the live link, wherever it was minted.
	it("shows the active invite's token from the server, whoever minted it", async () => {
		invitesGetFullList.mockResolvedValue([{ id: 'inv9', expires_at: future, token: 'tok9' }]);

		expect(await currentInvite('list1')).toMatchObject({ id: 'inv9', token: 'tok9' });
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('shows a link minted before the server kept tokens without one, and mints nothing', async () => {
		invitesGetFullList.mockResolvedValue([{ id: 'inv9', expires_at: future }]);

		const invite = await currentInvite('list1');

		expect(invite?.id).toBe('inv9');
		expect(invite?.token).toBeUndefined();
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('rotates through one mint and remembers the new token', async () => {
		const invite = await rotateInvite('list1');

		expect(pbSend).toHaveBeenCalledTimes(1);
		expect(invite.token).toBe('server-minted-token');
		expect(await cachedInviteToken('list1', 'inv-new')).toBe('server-minted-token');
	});

	// [D-148] the token cache is cleared on sign-out; a mint answering after the
	// sign-out must not write it back for the next account on this device
	// (§5.6 [D-109]).
	it('a mint that answers after sign-out caches nothing', async () => {
		resetSessionForTest();
		let answer!: (v: unknown) => void;
		pbSend.mockReturnValue(new Promise((r) => (answer = r)));

		const rotating = rotateInvite('list1');
		await vi.waitFor(() => expect(pbSend).toHaveBeenCalled());
		endSession();
		answer({ id: 'inv-new', expires_at: future, token: 'server-minted-token' });
		await rotating;

		expect(await db.meta.get(INVITE_TOKEN_META_PREFIX + 'list1')).toBeUndefined();
	});
});
