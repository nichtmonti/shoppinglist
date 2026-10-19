// #lib/actions/account.ts — the §4.5/§5.4/§5.6 account-lifecycle mutations.
//
// Three of these are irreversible or session-ending. The harness: a fake `#lib/pb.js`
// (`authStore`/`collection()`/`send()`), a fake `#lib/auth/index.js`, and a REAL Dexie —
// deletionImpact() counts off the roster cache, refreshed first (its refresh is
// injected here), and there is no value in a double for that.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accountsUpdate, credentialsGetFullList, credentialsDelete, pbSend } = vi.hoisted(() => ({
	accountsUpdate: vi.fn().mockResolvedValue({}),
	credentialsGetFullList: vi.fn().mockResolvedValue([]),
	credentialsDelete: vi.fn().mockResolvedValue(true),
	pbSend: vi.fn().mockResolvedValue({ ok: true })
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		collections: {
			accounts: { update: accountsUpdate },
			credentials: { getFullList: credentialsGetFullList, delete: credentialsDelete }
		},
		send: pbSend
	});
});

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock();
});

import { db } from '#lib/db.js';
import { makeMembership, resetDb } from '#lib/test-kit/db.js';
import { login, logout, oidcLogin, WrongAccountError } from '#lib/auth/index.js';
import { defaultAuthMethods } from '#lib/test-kit/auth-mock.js';
import {
	deleteAccountForever,
	deleteSignIn,
	deletionImpact,
	listPasskeys,
	logoutEverywhere,
	removePasskey,
	updateNickname
} from './account';

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	accountsUpdate.mockResolvedValue({});
	credentialsGetFullList.mockResolvedValue([]);
	credentialsDelete.mockResolvedValue(true);
	pbSend.mockResolvedValue({ ok: true });
});

describe('logoutEverywhere (§5.6)', () => {
	it('rotates the account token key server-side, then ends the local session', async () => {
		await logoutEverywhere();

		expect(pbSend).toHaveBeenCalledWith('/api/account/rotate-token-key', { method: 'POST' });
		expect(vi.mocked(logout)).toHaveBeenCalled();
	});

	it('does NOT log out locally when the rotation fails', async () => {
		// The failure to design against: a user who sees the auth screen and
		// concludes the lost phone was signed out when nothing was revoked.
		pbSend.mockRejectedValueOnce(new Error('offline'));

		await expect(logoutEverywhere()).rejects.toThrow('offline');
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
	});
});

describe('deleteAccountForever (§4.5)', () => {
	it('posts to the dedicated deletion route and then logs out', async () => {
		await deleteAccountForever();

		// Never PB's implicit relation cascade — §4.5 is one server-side route.
		expect(pbSend).toHaveBeenCalledWith('/api/account/delete', { method: 'POST' });
		expect(vi.mocked(logout)).toHaveBeenCalled();
	});

	it('leaves the session intact when the route fails', async () => {
		pbSend.mockRejectedValueOnce(new Error('boom'));

		await expect(deleteAccountForever()).rejects.toThrow('boom');
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
	});
});

describe('deleteAccountForever signs in first ([D-309])', () => {
	const dismissed = () =>
		Object.assign(new Error('Passkey-Abfrage abgebrochen.'), { name: 'NotAllowedError' });

	it('asks this account’s passkey, then deletes', async () => {
		const order: string[] = [];
		vi.mocked(login).mockImplementationOnce(async () => void order.push('login'));
		pbSend.mockImplementationOnce(async () => void order.push('delete'));

		await deleteAccountForever('passkey');

		expect(vi.mocked(login)).toHaveBeenCalledWith({ expectAccount: 'account-1' });
		expect(order).toEqual(['login', 'delete']);
		expect(vi.mocked(logout)).toHaveBeenCalled();
	});

	it('signs in through the OIDC login of an account without a passkey', async () => {
		await deleteAccountForever({ oidc: 'oidc' });

		expect(vi.mocked(oidcLogin)).toHaveBeenCalledWith('oidc', { expectAccount: 'account-1' });
		expect(pbSend).toHaveBeenCalledWith('/api/account/delete', { method: 'POST' });
	});

	it.each([
		[
			'the passkey prompt is dismissed',
			'passkey' as const,
			() => vi.mocked(login).mockRejectedValueOnce(dismissed())
		],
		[
			'the OIDC sign-in is cancelled',
			{ oidc: 'oidc' },
			() => vi.mocked(oidcLogin).mockResolvedValueOnce(false)
		]
	])('keeps the account when %s', async (_, signIn, cancel) => {
		cancel();

		await expect(deleteAccountForever(signIn)).rejects.toThrow(
			'Sign-in canceled. Your account was not deleted.'
		);
		expect(pbSend).not.toHaveBeenCalled();
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
	});

	it('names a passkey of another account instead of deleting', async () => {
		vi.mocked(login).mockRejectedValueOnce(new WrongAccountError(false));

		await expect(deleteAccountForever('passkey')).rejects.toThrow(/different account/);
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('asks for nothing on an account without a login (a demo account)', async () => {
		await deleteAccountForever();

		expect(vi.mocked(login)).not.toHaveBeenCalled();
		expect(vi.mocked(oidcLogin)).not.toHaveBeenCalled();
		expect(pbSend).toHaveBeenCalledWith('/api/account/delete', { method: 'POST' });
	});
});

describe('deleteSignIn ([D-309])', () => {
	const linked = defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', linked: true } });
	const passkey = { id: 'c1', friendly_name: '', last_used_at: '' };

	it('picks the passkey when the account has one', async () => {
		credentialsGetFullList.mockResolvedValueOnce([passkey]);
		expect(await deleteSignIn(linked)).toBe('passkey');
	});

	it('picks the linked OIDC login when the account has no passkey', async () => {
		expect(await deleteSignIn(linked)).toEqual({ oidc: 'oidc' });
	});

	it('picks the OIDC login on an instance without passkeys', async () => {
		const methods = { ...linked, passkeys: { enabled: false, signup: false } };
		expect(await deleteSignIn(methods)).toEqual({ oidc: 'oidc' });
		expect(credentialsGetFullList).not.toHaveBeenCalled();
	});

	it('asks for nothing when the account has neither', async () => {
		expect(await deleteSignIn(defaultAuthMethods())).toBeNull();
	});
});

describe('deletionImpact (§4.5 confirmation copy)', () => {
	it('counts a multi-member roster as shared and everything else as solo', async () => {
		await db.memberships.bulkPut([
			makeMembership({ list: 'list-shared' }),
			makeMembership({ list: 'list-solo' }),
			// No roster rows cached yet (§7.4's cache can lag a join) -> counted solo.
			makeMembership({ list: 'list-nocache' })
		]);
		await db.roster.bulkPut([
			{
				id: 'list-shared_account-1',
				list: 'list-shared',
				account: 'account-1',
				nickname: 'Ich',
				joined: '2026-01-01T00:00:00.000Z'
			},
			{
				id: 'list-shared_account-2',
				list: 'list-shared',
				account: 'account-2',
				nickname: 'Ben',
				joined: '2026-01-02T00:00:00.000Z'
			},
			{
				id: 'list-solo_account-1',
				list: 'list-solo',
				account: 'account-1',
				nickname: 'Ich',
				joined: '2026-01-01T00:00:00.000Z'
			}
		]);

		// Every refresh fails (offline): the cache is the answer.
		const offline = vi.fn().mockRejectedValue(new Error('offline'));
		expect(await deletionImpact(offline)).toEqual({ shared: 1, solo: 2 });
		expect(offline).toHaveBeenCalledTimes(3);
	});

	// The cache predates a join: refreshing it first is what keeps the sentence
	// before an irreversible delete true.
	it('counts a list as shared once its refreshed roster shows the new member', async () => {
		await db.memberships.put(makeMembership({ list: 'list-familie' }));
		await db.roster.put({
			id: 'list-familie_account-1',
			list: 'list-familie',
			account: 'account-1',
			nickname: 'Anna',
			joined: '2026-01-01T00:00:00.000Z'
		});
		const refresh = vi.fn(async (listId: string) => {
			await db.roster.put({
				id: `${listId}_account-2`,
				list: listId,
				account: 'account-2',
				nickname: 'Ben',
				joined: '2026-01-02T00:00:00.000Z'
			});
		});

		expect(await deletionImpact(refresh)).toEqual({ shared: 1, solo: 0 });
		expect(refresh).toHaveBeenCalledWith('list-familie');
	});

	it('reports zeroes for an account in no lists', async () => {
		expect(await deletionImpact(vi.fn())).toEqual({ shared: 0, solo: 0 });
	});
});

describe('passkeys (§5.4)', () => {
	it('removePasskey issues the credentials delete for that row only', async () => {
		await removePasskey('cred-7');

		expect(credentialsDelete).toHaveBeenCalledWith('cred-7');
	});

	it('propagates the server guard refusal rather than swallowing it ([D-32])', async () => {
		credentialsDelete.mockRejectedValueOnce(new Error('cannot delete the last passkey'));

		await expect(removePasskey('cred-7')).rejects.toThrow('cannot delete the last passkey');
	});

	it('listPasskeys normalises missing friendly_name/last_used_at', async () => {
		credentialsGetFullList.mockResolvedValueOnce([
			{ id: 'c1', friendly_name: 'iPhone', last_used_at: '2026-07-01 10:00:00Z' },
			{ id: 'c2' }
		]);

		expect(await listPasskeys()).toEqual([
			{ id: 'c1', friendly_name: 'iPhone', last_used_at: '2026-07-01 10:00:00Z' },
			{ id: 'c2', friendly_name: '', last_used_at: null }
		]);
	});
});

describe('updateNickname (§11 own-row allowlist)', () => {
	it('updates only nickname, on the signed-in account row', async () => {
		await updateNickname('Anna');

		expect(accountsUpdate).toHaveBeenCalledWith('account-1', { nickname: 'Anna' });
	});
});
