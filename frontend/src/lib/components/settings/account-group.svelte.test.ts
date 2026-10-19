// AccountGroup — nickname save, and the OIDC link and its removal. Follows
// the harness pattern documented in auth-screen.svelte.test.ts: mock #lib/pb
// (no PocketBase runs here) and #lib/auth (authState), leave the online
// store real (happy-dom defaults to onLine).
import { t } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accountsUpdate, pbSend } = vi.hoisted(() => ({
	accountsUpdate: vi.fn().mockResolvedValue({}),
	pbSend: vi.fn().mockResolvedValue({ ok: true })
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({ collections: { accounts: { update: accountsUpdate } }, send: pbSend });
});

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock({}, { isValid: true });
});

import { authState, fetchAuthMethods, linkOidc, unlinkOidc } from '#lib/auth/index.js';
import { defaultAuthMethods } from '#lib/test-kit/auth-mock.js';
import AccountGroup from './AccountGroup.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	accountsUpdate.mockResolvedValue({});
	pbSend.mockResolvedValue({});
});

/** The nickname row: a button named by its label, line and value. */
const nicknameRow = () => screen.getByRole('button', { name: /^Spitzname/ });

describe('AccountGroup', () => {
	// An OIDC provider that sent no name claim leaves the nickname empty.
	it('shows a placeholder for an empty nickname, and edits from empty', async () => {
		(authState as unknown as { set(v: object): void }).set({ nickname: '', isValid: true });
		render(AccountGroup);

		expect(screen.getByTestId('settings-nickname').textContent).toBe('Mitglied');
		await fireEvent.click(nicknameRow());
		expect(
			(await screen.findByRole<HTMLInputElement>('textbox', { name: 'Spitzname' })).value
		).toBe('');
	});

	it('saves a nickname change via the own-row accounts update', async () => {
		render(AccountGroup);

		// The row opens a prompt ([D-269]).
		expect(screen.queryByRole('textbox', { name: 'Spitzname' })).toBeNull();
		await fireEvent.click(nicknameRow());
		const input = await screen.findByRole('textbox', { name: 'Spitzname' });
		await fireEvent.input(input, { target: { value: 'Anna' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(() => {
			expect(accountsUpdate).toHaveBeenCalledWith('account-1', { nickname: 'Anna' });
		});
		// A rename that stuck closes the prompt.
		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Spitzname' })).toBeNull());
	});

	it('Abbrechen abandons the edit without saving', async () => {
		render(AccountGroup);

		await fireEvent.click(nicknameRow());
		const input = await screen.findByRole('textbox', { name: 'Spitzname' });
		await fireEvent.input(input, { target: { value: 'Anna' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Spitzname' })).toBeNull());
		expect(accountsUpdate).not.toHaveBeenCalled();
	});

	it('shows a refused save in the prompt and keeps it open', async () => {
		accountsUpdate.mockRejectedValueOnce(new Error('Zu lang'));
		render(AccountGroup);

		await fireEvent.click(nicknameRow());
		const input = await screen.findByRole('textbox', { name: 'Spitzname' });
		await fireEvent.input(input, { target: { value: 'Anna' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		// The server's own words are never shown ([D-293]).
		expect(await screen.findByText(t('common_error'))).toBeDefined();
		expect(screen.getByRole('textbox', { name: 'Spitzname' })).toBeDefined();
	});
});

// §5.9 [D-76]: the OIDC link. Offered only when the instance has an
// OIDC provider AND the server reports this account has no OIDC login yet
// ([D-25]: the record carries no email that could tell).
describe('AccountGroup — the OIDC link entry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		accountsUpdate.mockResolvedValue({});
		pbSend.mockResolvedValue({});
	});

	it('stays hidden when the instance offers no OIDC login', async () => {
		render(AccountGroup);
		await waitFor(() => expect(vi.mocked(fetchAuthMethods)).toHaveBeenCalled());
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /Mit .* verbinden/ })).toBeNull();
		});
		expect(screen.queryByText(/Verbunden mit/)).toBeNull();
	});

	it('offers the link on a passkey account and calls it with the provider', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		render(AccountGroup);
		await waitFor(() => expect(vi.mocked(fetchAuthMethods)).toHaveBeenCalled());
		// What the server says once the link went through.
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({
				oidc: { enabled: true, provider: 'oidc', name: 'Keycloak', linked: true, identity: 'anna' }
			})
		);

		const button = await screen.findByRole('button', { name: /^Mit Keycloak verbinden/ });
		// The hint names the provider too (it once read "deine undefined-Anmeldung").
		expect(screen.getByText(/deine Keycloak-Anmeldung/)).toBeDefined();
		await fireEvent.click(button);
		await waitFor(() => {
			expect(vi.mocked(linkOidc)).toHaveBeenCalledWith('oidc');
		});
		// Linked now: the entry's own precondition is gone, and the card says
		// which login the account has instead.
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /^Mit Keycloak verbinden/ })).toBeNull();
		});
		expect(await screen.findByText('Verbunden mit Keycloak als anna.')).toBeDefined();
	});

	// [D-76]: an OIDC login whose account has lists of its own is refused;
	// the card shows why and keeps offering the link.
	it('shows a refused link and keeps offering it', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		vi.mocked(linkOidc).mockRejectedValueOnce(
			new LocalizedError('Diese Anmeldung gehört schon zu einem anderen Konto mit eigenen Listen.')
		);
		render(AccountGroup);

		await fireEvent.click(await screen.findByRole('button', { name: /^Mit Keycloak verbinden/ }));

		expect(
			await screen.findByText(
				'Diese Anmeldung gehört schon zu einem anderen Konto mit eigenen Listen.'
			)
		).toBeDefined();
		expect(screen.getByRole('button', { name: /^Mit Keycloak verbinden/ })).toBeDefined();
		expect(screen.queryByText(/Verbunden mit Keycloak/)).toBeNull();
	});

	it('shows the OIDC login instead of the link on an account that has it', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({
				oidc: { enabled: true, provider: 'oidc', name: 'Keycloak', linked: true }
			})
		);

		render(AccountGroup);
		expect(await screen.findByText('Verbunden mit Keycloak.')).toBeDefined();
		expect(screen.queryByRole('button', { name: /^Mit Keycloak verbinden/ })).toBeNull();
	});

	// [D-76]: which identity the login is connected as, and its removal.
	const linkedAs = (identity?: string, passkeys = true) =>
		defaultAuthMethods({
			passkeys: { enabled: passkeys },
			oidc: { enabled: true, provider: 'oidc', name: 'Keycloak', linked: true, identity }
		});

	it('names the identity the login is connected as', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(linkedAs('anna@example.com'));
		render(AccountGroup);
		expect(await screen.findByText('Verbunden mit Keycloak als anna@example.com.')).toBeDefined();
	});

	it('removes the login after a confirmation, and offers the link again', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(linkedAs('anna'));
		render(AccountGroup);

		await fireEvent.click(await screen.findByRole('button', { name: 'Anmeldung entfernen' }));
		expect(screen.getByText('Keycloak-Anmeldung entfernen?')).toBeDefined();
		// The consequence is spelled out before anything happens.
		expect(screen.getByText(/erstellt danach ein neues, leeres Konto/)).toBeDefined();
		expect(vi.mocked(unlinkOidc)).not.toHaveBeenCalled();

		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Entfernen' }));

		await waitFor(() => expect(vi.mocked(unlinkOidc)).toHaveBeenCalled());
		expect(await screen.findByRole('button', { name: /^Mit Keycloak verbinden/ })).toBeDefined();
		expect(screen.queryByText(/Verbunden mit/)).toBeNull();
		expect(screen.queryByText('Keycloak-Anmeldung entfernen?')).toBeNull();
	});

	it('shows a refusal inside the dialog and keeps the login', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(linkedAs('anna'));
		vi.mocked(unlinkOidc).mockRejectedValueOnce(
			new LocalizedError('Füge zuerst einen Passkey hinzu')
		);
		render(AccountGroup);

		await fireEvent.click(await screen.findByRole('button', { name: 'Anmeldung entfernen' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Entfernen' }));

		expect(await screen.findByText('Füge zuerst einen Passkey hinzu')).toBeDefined();
		expect(screen.getByText('Keycloak-Anmeldung entfernen?')).toBeDefined();
		expect(screen.getByText('Verbunden mit Keycloak als anna.')).toBeDefined();
	});

	it('offers no removal while passkeys are off — the OIDC login is the only way in', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(linkedAs('anna', false));
		render(AccountGroup);

		expect(await screen.findByText('Verbunden mit Keycloak als anna.')).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Anmeldung entfernen' })).toBeNull();
	});
});
