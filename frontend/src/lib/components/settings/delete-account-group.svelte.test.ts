// DeleteAccountGroup — the irreversible path (§4.5). It is behind an in-UI
// two-step confirm (plain component state — no native confirm(), which
// happy-dom stubs anyway), so the tests below assert the same two things: the
// first tap does NOT fire the action, and the second one does. #lib/db stays
// real (deletionImpact's shared/solo count needs the Dexie-backed stores);
// #lib/pb and #lib/auth (logout) are mocked.
import { t } from '#lib/i18n/index.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pbSend } = vi.hoisted(() => ({
	pbSend: vi.fn().mockResolvedValue({ ok: true })
}));

// The account has a passkey, so confirming asks for it first ([D-309]).
vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({
		send: pbSend,
		collections: { credentials: { getFullList: async () => [{ id: 'c1' }] } }
	})
);

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock({}, { isValid: true });
});

import { db } from '#lib/db.js';
import { resetDb, putMyList } from '#lib/test-kit/db.js';
import { login, logout } from '#lib/auth/index.js';
import DeleteAccountGroup from './DeleteAccountGroup.svelte';

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	pbSend.mockResolvedValue({ ok: true });
});

describe('DeleteAccountGroup', () => {
	it('counts shared vs. solo lists for the delete-account confirmation', async () => {
		// list-shared: two roster entries (this account + another) -> shared.
		// list-solo: one roster entry (this account only) -> solo.
		// list-nocache: no roster rows cached yet -> treated as solo.
		await putMyList('list-shared', 'Familie', { account: 'account-1' });
		await putMyList('list-solo', 'Nur ich', { account: 'account-1' });
		await putMyList('list-nocache', 'Frisch', { account: 'account-1' });
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

		render(DeleteAccountGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Konto endgültig löschen' }));

		await waitFor(() => {
			expect(
				screen.getByText(
					'Deine geteilte Liste bleibt bei ihren Mitgliedern. Deine 2 eigenen Listen werden endgültig gelöscht.'
				)
			).toBeDefined();
		});
	});

	it('deletes the account only after the confirmation step (§4.5)', async () => {
		render(DeleteAccountGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Konto endgültig löschen' }));
		expect(await screen.findByRole('button', { name: 'Konto löschen' })).toBeDefined();
		expect(pbSend).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Konto löschen' }));

		await waitFor(() =>
			expect(pbSend).toHaveBeenCalledWith('/api/account/delete', { method: 'POST' })
		);
		await waitFor(() => expect(vi.mocked(logout)).toHaveBeenCalled());
	});

	it('asks for the passkey before deleting, and keeps the account when it is dismissed ([D-309])', async () => {
		vi.mocked(login).mockRejectedValueOnce(
			Object.assign(new Error('Passkey-Abfrage abgebrochen.'), { name: 'NotAllowedError' })
		);
		render(DeleteAccountGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Konto endgültig löschen' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Konto löschen' }));

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Anmeldung abgebrochen. Dein Konto wurde nicht gelöscht.');
		expect(vi.mocked(login)).toHaveBeenCalledWith({ expectAccount: 'account-1' });
		expect(pbSend).not.toHaveBeenCalled();
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
	});

	it('reports a failed account deletion instead of pretending it worked', async () => {
		pbSend.mockRejectedValueOnce(new Error('Serverfehler'));

		render(DeleteAccountGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Konto endgültig löschen' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Konto löschen' }));

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain(t('common_error'));
		expect(vi.mocked(logout)).not.toHaveBeenCalled();
	});
});

describe('DeleteAccountGroup — graded severity ([D-214])', () => {
	it('is the one red row, and its confirmation the solid red', async () => {
		render(DeleteAccountGroup);

		const del = screen.getByRole('button', { name: 'Konto endgültig löschen' });
		expect(document.getElementById(del.getAttribute('aria-labelledby')!)?.className).toContain(
			'text-danger'
		);

		// The confirm carries the strength of what it does.
		await fireEvent.click(del);
		expect((await screen.findByRole('button', { name: 'Konto löschen' })).className).toContain(
			'bg-danger'
		);
	});

	it('says plainly what deleting takes when the account is in no list', async () => {
		render(DeleteAccountGroup);

		await fireEvent.click(screen.getByRole('button', { name: 'Konto endgültig löschen' }));

		expect(
			await screen.findByText('Du bist in keiner Liste. Gelöscht wird nur dein Konto.')
		).toBeDefined();
	});
});
