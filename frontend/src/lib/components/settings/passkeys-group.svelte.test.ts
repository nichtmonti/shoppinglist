// PasskeysGroup — list/rename/remove/add ([D-269]): a row per passkey opens
// its sheet, whose rename and remove open a prompt and a confirmation. Mocks #lib/pb (credentials collection) and #lib/auth's
// addPasskey (the ceremony helper actions/account re-exports — see the
// "second account" note inside the first test).
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { credentialsGetFullList, credentialsDelete, pbSend } = vi.hoisted(() => ({
	credentialsGetFullList: vi.fn().mockResolvedValue([]),
	credentialsDelete: vi.fn().mockResolvedValue(true),
	pbSend: vi.fn().mockResolvedValue({})
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		collections: {
			credentials: { getFullList: credentialsGetFullList, delete: credentialsDelete }
		},
		send: pbSend
	});
});

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock({}, { isValid: true });
});

import { addPasskey } from '#lib/auth/index.js';
import { t } from '#lib/i18n/index.js';
import PasskeysGroup from './PasskeysGroup.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	credentialsGetFullList.mockResolvedValue([]);
	credentialsDelete.mockResolvedValue(true);
});

/** Opens a passkey's sheet from its row (named by its name and its line). */
async function openPasskey(name: string): Promise<void> {
	await fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
}

describe('PasskeysGroup — rename', () => {
	it('renames a passkey from its sheet and reloads the list', async () => {
		credentialsGetFullList.mockResolvedValue([
			{ id: 'c1', friendly_name: 'Handy', last_used_at: '' }
		]);
		render(PasskeysGroup);

		await openPasskey('Handy');
		await fireEvent.click(await screen.findByRole('button', { name: 'Umbenennen' }));
		const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Name' });
		expect(input.value).toBe('Handy');
		await fireEvent.input(input, { target: { value: 'Telefon' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(() =>
			expect(pbSend).toHaveBeenCalledWith(
				'/api/credentials/c1/rename',
				expect.objectContaining({ method: 'POST' })
			)
		);
		await waitFor(() => expect(credentialsGetFullList).toHaveBeenCalledTimes(2));
	});

	// One passkey's failed rename belongs to that attempt: another passkey's
	// prompt does not show it.
	it("a failed rename does not follow the user into another passkey's prompt", async () => {
		credentialsGetFullList.mockResolvedValue([
			{ id: 'c1', friendly_name: 'Handy', last_used_at: '' },
			{ id: 'c2', friendly_name: 'Laptop', last_used_at: '' }
		]);
		pbSend.mockRejectedValueOnce(new Error('Name schon vergeben'));
		render(PasskeysGroup);

		await openPasskey('Handy');
		await fireEvent.click(await screen.findByRole('button', { name: 'Umbenennen' }));
		await fireEvent.input(await screen.findByRole('textbox', { name: 'Name' }), {
			target: { value: 'Telefon' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
		expect(await screen.findByText(t('common_error'))).toBeDefined();

		await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
		await openPasskey('Laptop');
		await fireEvent.click(await screen.findByRole('button', { name: 'Umbenennen' }));

		expect(await screen.findByRole('textbox', { name: 'Name' })).toBeDefined();
		expect(screen.queryByText(t('common_error'))).toBeNull();
	});
});

describe('PasskeysGroup', () => {
	// "Keine Passkeys" is an answer; while the list is in flight there is none.
	it('says nothing about passkeys until the list has arrived', async () => {
		let answer!: (rows: unknown[]) => void;
		credentialsGetFullList.mockReturnValueOnce(new Promise((r) => (answer = r)));
		render(PasskeysGroup);
		await waitFor(() => expect(credentialsGetFullList).toHaveBeenCalled());
		expect(screen.queryByText(t('settings_no_passkeys'))).toBeNull();

		answer([]);
		expect(await screen.findByText(t('settings_no_passkeys'))).toBeDefined();
	});

	// [D-205]: the route's preload is the first frame, and the group does not
	// ask again.
	it('renders the preloaded list on its first frame, without fetching it', () => {
		render(PasskeysGroup, {
			props: { preloaded: [{ id: 'c1', friendly_name: 'Handy', last_used_at: null }] }
		});
		expect(screen.getByRole('button', { name: /^Handy/ })).toBeDefined();
		expect(screen.getByText(t('settings_backup_key_nudge'))).toBeDefined();
		expect(credentialsGetFullList).not.toHaveBeenCalled();
	});

	// The nudge is for the second key.
	it('nudges for a second passkey only while there is one', async () => {
		credentialsGetFullList.mockResolvedValue([
			{ id: 'c1', friendly_name: 'Handy', last_used_at: '' }
		]);
		const { unmount } = render(PasskeysGroup);
		expect(await screen.findByText(t('settings_backup_key_nudge'))).toBeDefined();
		unmount();

		credentialsGetFullList.mockResolvedValue([
			{ id: 'c1', friendly_name: 'Handy', last_used_at: '' },
			{ id: 'c2', friendly_name: 'Laptop', last_used_at: '' }
		]);
		render(PasskeysGroup);
		await screen.findByRole('button', { name: /^Laptop/ });
		expect(screen.queryByText(t('settings_backup_key_nudge'))).toBeNull();
	});

	it('adds a backup passkey with the typed name and reloads the passkey list', async () => {
		// #lib/auth.addPasskey (not register()) is the correct call here: register()
		// never attaches the session's Authorization header, so calling it while
		// signed in would silently mint a SECOND account instead of adding a
		// credential to this one — see #lib/auth/passkey.ts's addPasskey doc comment.
		render(PasskeysGroup);

		await waitFor(() => expect(credentialsGetFullList).toHaveBeenCalledTimes(1));

		// The row asks for the name before the ceremony.
		await fireEvent.click(screen.getByRole('button', { name: 'Passkey hinzufügen' }));
		const nameInput = await screen.findByRole('textbox', { name: 'Name für den neuen Passkey' });
		// The server caps the name (field contract); past it the add fails with a
		// generic message, so the field stops at it.
		expect(nameInput.getAttribute('maxlength')).toBe('64');
		await fireEvent.input(nameInput, { target: { value: 'Mein iPhone' } });
		await fireEvent.submit(nameInput.closest('form')!);

		await waitFor(() => {
			expect(vi.mocked(addPasskey)).toHaveBeenCalledWith('Mein iPhone');
			expect(credentialsGetFullList).toHaveBeenCalledTimes(2);
		});
	});

	it('removes a passkey only after the confirmation, then reloads the list (§5.4)', async () => {
		credentialsGetFullList.mockResolvedValue([
			{ id: 'cred-1', friendly_name: 'iPhone', last_used_at: null },
			{ id: 'cred-2', friendly_name: 'Laptop', last_used_at: null }
		]);

		render(PasskeysGroup);

		await openPasskey('iPhone');
		await fireEvent.click(await screen.findByRole('button', { name: 'Passkey entfernen' }));
		expect(credentialsDelete).not.toHaveBeenCalled();
		// The confirmation names the passkey ([D-214]).
		expect(await screen.findByText(/„iPhone“/)).toBeDefined();

		await fireEvent.click(await screen.findByRole('button', { name: 'Entfernen' }));

		await waitFor(() => expect(credentialsDelete).toHaveBeenCalledWith('cred-1'));
		// Reloaded so the screen reflects the server after a delete that the
		// [D-32] guard could equally well have refused.
		await waitFor(() => expect(credentialsGetFullList).toHaveBeenCalledTimes(2));
	});

	// [D-293] The server keeps an account's last login (§5.4, [D-32]); the
	// row says so instead of offering a removal that can only fail.
	it('does not offer to remove the only login, and says why', async () => {
		credentialsGetFullList.mockResolvedValue([
			{ id: 'cred-1', friendly_name: 'iPhone', last_used_at: null }
		]);

		render(PasskeysGroup);

		await openPasskey('iPhone');
		const remove = await screen.findByRole('button', { name: 'Passkey entfernen' });
		expect((remove as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/einzige Weg in dein Konto/)).toBeDefined();
	});

	it("shows the server's refusal in the user's language, not the server's English", async () => {
		credentialsGetFullList.mockResolvedValue([
			{ id: 'cred-1', friendly_name: 'iPhone', last_used_at: null },
			{ id: 'cred-2', friendly_name: 'Laptop', last_used_at: null }
		]);
		// The other passkey went on another device meanwhile.
		credentialsDelete.mockRejectedValueOnce(
			Object.assign(
				new Error('cannot delete the last passkey of an account without another login'),
				{
					status: 403
				}
			)
		);

		render(PasskeysGroup);

		await openPasskey('iPhone');
		await fireEvent.click(await screen.findByRole('button', { name: 'Passkey entfernen' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Entfernen' }));

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('einzige Weg in dein Konto');
		expect(alert.textContent).not.toContain('cannot delete');
	});
});
