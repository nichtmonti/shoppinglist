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

import { activeInvite, createInvite, resetInvite, revokeInvite, tokenFromInput } from './invites';

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

describe("the share sheet's invite (activeInvite / resetInvite)", () => {
	// [D-330] Opening the share sheet never mints: a revoked link stays revoked.
	it('is null when the list has no active invite, and mints nothing', async () => {
		expect(await activeInvite('list1')).toBeNull();
		expect(pbSend).not.toHaveBeenCalled();
	});

	// [D-294] Any member shares the live link, wherever it was minted.
	it("shows the active invite's token from the server, whoever minted it", async () => {
		invitesGetFullList.mockResolvedValue([{ id: 'inv9', expires_at: future, token: 'tok9' }]);

		expect(await activeInvite('list1')).toMatchObject({ id: 'inv9', token: 'tok9' });
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('shows a link minted before the server kept tokens without one, and mints nothing', async () => {
		invitesGetFullList.mockResolvedValue([{ id: 'inv9', expires_at: future }]);

		const invite = await activeInvite('list1');

		expect(invite?.id).toBe('inv9');
		expect(invite?.token).toBeUndefined();
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('resets through one mint, which answers with the new token', async () => {
		const invite = await resetInvite('list1');

		expect(pbSend).toHaveBeenCalledTimes(1);
		expect(invite.token).toBe('server-minted-token');
	});
});
