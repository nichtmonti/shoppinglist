// The component-harness proof for the `client` vitest project (happy-dom +
// @testing-library/svelte + runes mode + the #lib alias + module mocking),
// against the §5.4 auth screen. This file also documents the pattern the other
// component tests follow.
import { LocalizedError } from '#lib/localized-error.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #lib/auth reaches for IndexedDB (the async auth store) and WebAuthn on import,
// neither of which belongs in a render test — mock the whole module through the
// shared factory ([D-77]); per-test overrides below use vi.mocked on the same
// instances the factory created.
vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock();
});

import {
	canUsePasskeyAutofill,
	canUsePasskeys,
	fetchAuthMethods,
	login,
	oidcLogin,
	cancelOidcLogin,
	clearSetupToken,
	isCeremonyDismissal,
	register,
	setupToken
} from '#lib/auth/index.js';
import { resetDb } from '#lib/test-kit/db.js';
import { defaultAuthMethods } from '#lib/test-kit/auth-mock.js';
import { localePref } from '#lib/state/prefs.js';
import AuthScreen from './AuthScreen.svelte';

/**
 * Render and wait for the instance's sign-in options ([D-76]): the screen
 * shows a placeholder until `fetchAuthMethods` answers.
 */
async function renderAuth() {
	const result = render(AuthScreen);
	await waitFor(() => expect(screen.queryByText('Anmeldung wird vorbereitet …')).toBeNull());
	return result;
}

describe('AuthScreen', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		vi.mocked(canUsePasskeys).mockReturnValue(true);
		vi.mocked(canUsePasskeyAutofill).mockResolvedValue(true);
		// The conditional ceremony never settles in the real browser until the
		// user picks a credential; a resolved default would make every test look
		// like a successful silent login.
		vi.mocked(login).mockReturnValue(new Promise<void>(() => {}));
		// The nickname draft is REAL module state shared across renders in
		// this file — start each test from an empty one.
	});

	it('offers registration and login when signed out', async () => {
		await renderAuth();

		expect(screen.getByRole('button', { name: 'Konto erstellen' })).toBeDefined();
		expect(screen.getByRole('button', { name: 'Mit Passkey anmelden' })).toBeDefined();
	});

	it('names the two doors with their own headings', async () => {
		await renderAuth();
		expect(screen.getByRole('heading', { name: 'Schon ein Konto?' })).toBeDefined();
		expect(screen.getByRole('heading', { name: 'Neu hier?' })).toBeDefined();
	});

	// [D-69]: without an invite, a visitor may well be returning.
	it('puts sign-in first', async () => {
		await renderAuth();
		const signIn = screen.getByRole('button', { name: 'Mit Passkey anmelden' });
		const create = screen.getByRole('button', { name: 'Konto erstellen' });
		expect(signIn.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// The label names the field; the placeholder gives an example, as the
	// passkey name's „z. B. iPhone“ does, instead of saying the label again.
	it('labels the nickname field and gives an example', async () => {
		await renderAuth();
		expect(screen.getByLabelText('Spitzname').getAttribute('placeholder')).toBe('z. B. Anna');
	});

	// The button stays pressable without a nickname: a disabled outline read as
	// a styling choice and could not say what it was waiting for.
	it('asks for a nickname instead of disabling "Konto erstellen"', async () => {
		await renderAuth();
		const button = screen.getByRole('button', { name: 'Konto erstellen' });
		const field = screen.getByLabelText('Spitzname');
		expect((button as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(button);
		expect(vi.mocked(register)).not.toHaveBeenCalled();
		expect(screen.getByRole('alert').textContent?.trim()).toBe('Gib zuerst einen Spitznamen ein.');
		expect(field.getAttribute('aria-invalid')).toBe('true');
		// The Field wires the error to the field ([D-325]).
		expect(field.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
		expect(document.activeElement).toBe(field);

		await fireEvent.input(field, { target: { value: 'Anna' } });
		expect(screen.queryByRole('alert')).toBeNull();
		expect(field.getAttribute('aria-invalid')).toBeNull();

		await fireEvent.click(button);
		expect(vi.mocked(register)).toHaveBeenCalledWith('Anna', undefined);
	});

	it('logs in with a passkey', async () => {
		await renderAuth();
		await fireEvent.click(screen.getByRole('button', { name: 'Mit Passkey anmelden' }));
		expect(vi.mocked(login)).toHaveBeenCalled();
	});
	it('renders the thrown ceremony message when registration fails', async () => {
		vi.mocked(register).mockRejectedValue(
			new LocalizedError(
				'Für diesen Spitznamen ist auf diesem Gerät schon ein Passkey gespeichert.'
			)
		);
		await renderAuth();

		await fireEvent.input(screen.getByLabelText('Spitzname'), { target: { value: 'Anna' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Konto erstellen' }));

		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe(
				'Für diesen Spitznamen ist auf diesem Gerät schon ein Passkey gespeichert.'
			)
		);
	});

	it('explains itself when the browser has no passkey support', async () => {
		vi.mocked(canUsePasskeys).mockReturnValue(false);
		await renderAuth();

		expect(screen.getByRole('heading', { name: 'Passkeys nicht unterstützt' })).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Konto erstellen' })).toBeNull();
	});
});

// §5.4's credentials are discoverable server-side (registerBegin requires a
// resident key; loginBegin uses BeginDiscoverableLogin) but nothing asked the
// browser to OFFER them, so a returning visitor could only find their passkey
// by knowing to press the second button — and pressing the first minted a
// duplicate account instead.
/** Waits until the background ceremony's rejection has been handled and
 *  rendered: an alert checked any earlier would be absent either way. */
async function settledBackgroundLogin() {
	await waitFor(() => expect(vi.mocked(isCeremonyDismissal)).toHaveBeenCalled());
	await tick();
}

describe('AuthScreen — discovering an existing passkey', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		vi.mocked(canUsePasskeys).mockReturnValue(true);
		vi.mocked(canUsePasskeyAutofill).mockResolvedValue(true);
		vi.mocked(login).mockReturnValue(new Promise<void>(() => {}));
		// The nickname draft is REAL module state shared across renders in
		// this file — start each test from an empty one.
	});

	it('starts a conditional-mediation ceremony on mount', async () => {
		await renderAuth();

		await waitFor(() => expect(vi.mocked(login)).toHaveBeenCalledWith({ conditional: true }));
	});

	// The autofill dropdown binds to an input whose `autocomplete` ENDS in
	// "webauthn"; @simplewebauthn refuses to start the ceremony without one.
	it('anchors the ceremony on a webauthn-autofill field', async () => {
		await renderAuth();

		expect(screen.getByLabelText('Spitzname').getAttribute('autocomplete')).toBe(
			'username webauthn'
		);
	});

	it('does not start one when the browser cannot do conditional mediation', async () => {
		vi.mocked(canUsePasskeyAutofill).mockResolvedValue(false);
		await renderAuth();

		await waitFor(() => expect(vi.mocked(canUsePasskeyAutofill)).toHaveBeenCalled());
		expect(vi.mocked(login)).not.toHaveBeenCalled();
	});

	// The background ceremony rejecting with NotAllowedError/AbortError is the
	// NORMAL path — the user dismissed the dropdown, or pressed a button and
	// WebAuthn (one ceremony at a time) cancelled this one. Surfacing it would
	// put "cancelled" on screen for simply choosing to type a nickname.
	it('stays silent when the background ceremony was dismissed or superseded', async () => {
		const dismissed = new Error('The operation either timed out or was not allowed.');
		dismissed.name = 'NotAllowedError';
		vi.mocked(login).mockRejectedValue(dismissed);
		await renderAuth();

		await settledBackgroundLogin();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	// A browser with no passkey provider (Chromium on a desktop without a
	// password manager that keeps passkeys) claims conditional mediation and
	// then refuses it at once: nobody engaged, so nothing may appear.
	it('stays silent when the browser refuses the autofill it offered', async () => {
		const refused = new Error('Resident credentials … are not supported at this time.');
		refused.name = 'NotSupportedError';
		vi.mocked(login).mockRejectedValue(refused);
		await renderAuth();

		await settledBackgroundLogin();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	// Anything else rejected AFTER the user engaged — here: they picked a
	// credential and the finish call failed — must not be swallowed along with
	// the dismissals, which would read as a dead button.
	it('surfaces a real failure instead of swallowing it', async () => {
		vi.mocked(login).mockRejectedValue(new LocalizedError('Anmeldung fehlgeschlagen.'));
		await renderAuth();

		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe('Anmeldung fehlgeschlagen.')
		);
	});

	it('stays silent when the capability probe itself throws', async () => {
		vi.mocked(canUsePasskeyAutofill).mockRejectedValue(new Error('probe exploded'));
		await renderAuth();

		await waitFor(() => expect(vi.mocked(canUsePasskeyAutofill)).toHaveBeenCalled());
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

// §12.2: settings sits behind the app shell's account gate, so the auth screen
// carries the language switch too — the visitor who most needs it, someone who
// cannot read the screen asking them to create an account, must reach it.
//
// The prefs store and Dexie are REAL here (as in settings/general-group.svelte.test.ts):
// both surfaces share one persistence
// path, so stubbing it would test nothing.
describe('AuthScreen — changing language before you have an account', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		vi.mocked(canUsePasskeys).mockReturnValue(true);
		vi.mocked(canUsePasskeyAutofill).mockResolvedValue(false);
		await resetDb();
		// The nickname draft is REAL module state shared across renders in
		// this file — start each test from an empty one.
	});

	it('offers the locale toggle while signed out', async () => {
		await renderAuth();

		const toggle = screen.getByTestId('auth-locale');
		expect(within(toggle).getByRole('radio', { name: 'Deutsch' })).toBeDefined();
		expect(within(toggle).getByRole('radio', { name: 'English' })).toBeDefined();
	});

	it('persists the choice through the shared preference path', async () => {
		await renderAuth();

		// 'Deutsch', not 'English': happy-dom's navigator asks for en-US, so the
		// English chip is already the active value — and a single-toggle group
		// DESELECTS on a second click, which LocaleToggle's value guard ignores
		// by design. Only a genuine change exercises the persistence path.
		await fireEvent.click(
			within(screen.getByTestId('auth-locale')).getByRole('radio', { name: 'Deutsch' })
		);

		await waitFor(() => {
			let current: string | undefined;
			localePref.subscribe((v) => (current = v))();
			expect(current).toBe('de');
		});
	});
});

// [D-291]: a language switch changes the strings in place, so what the visitor
// has typed stays.
describe('AuthScreen — a language switch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		vi.mocked(canUsePasskeys).mockReturnValue(true);
		vi.mocked(canUsePasskeyAutofill).mockResolvedValue(false);
	});

	it('keeps the half-typed nickname and relabels the field', async () => {
		await renderAuth();
		await fireEvent.input(screen.getByLabelText('Spitzname'), { target: { value: 'Anna' } });

		await fireEvent.click(
			within(screen.getByTestId('auth-locale')).getByRole('radio', { name: 'English' })
		);

		const field = await screen.findByLabelText('Nickname');
		expect((field as HTMLInputElement).value).toBe('Anna');
	});
});

// §5.9 [D-76]: the instance's OIDC login. The button is CONFIGURATION-gated
// (GET /api/auth/oidc), not capability-gated — and it must appear in the
// no-passkey branch too, because that branch is exactly where a browser
// without WebAuthn still needs a way in.
describe('AuthScreen — the OIDC login offering', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAuthMethods).mockResolvedValue(defaultAuthMethods());
		vi.mocked(canUsePasskeys).mockReturnValue(true);
		vi.mocked(canUsePasskeyAutofill).mockResolvedValue(false);
		vi.mocked(login).mockReturnValue(new Promise<void>(() => {}));
	});

	it('hides the provider button when the instance offers none', async () => {
		await renderAuth();
		await screen.findByRole('button', { name: 'Mit Passkey anmelden' });
		expect(screen.queryByRole('button', { name: /Weiter mit/ })).toBeNull();
	});

	it('offers the configured provider by its display name', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		await renderAuth();
		const button = await screen.findByRole('button', { name: 'Weiter mit Keycloak' });
		await fireEvent.click(button);
		expect(vi.mocked(oidcLogin)).toHaveBeenCalledWith('oidc');
	});

	it('turns the provider button into a cancel while the popup is open', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		// The attempt stays pending until cancelled, like a popup the user closed.
		let settle: (done: boolean) => void = () => {};
		vi.mocked(oidcLogin).mockImplementation(() => new Promise((r) => (settle = r)));
		vi.mocked(cancelOidcLogin).mockImplementation(() => settle(false));
		await renderAuth();

		await fireEvent.click(await screen.findByRole('button', { name: 'Weiter mit Keycloak' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Abbrechen' }));

		expect(vi.mocked(cancelOidcLogin)).toHaveBeenCalled();
		expect(await screen.findByRole('button', { name: 'Weiter mit Keycloak' })).toBeDefined();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('keeps offering the provider when passkeys are unsupported', async () => {
		vi.mocked(canUsePasskeys).mockReturnValue(false);
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' } })
		);
		await renderAuth();
		expect(await screen.findByRole('button', { name: 'Weiter mit Keycloak' })).toBeDefined();
		// …and the passkey buttons stay gone.
		expect(screen.queryByRole('button', { name: 'Mit Passkey anmelden' })).toBeNull();
	});

	// [D-76]: each half of the screen shows only when the instance offers it.
	it('hides the create-account half while passkey signup is closed', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ passkeys: { signup: false, signup_by_link: false } })
		);
		await renderAuth();
		await screen.findByRole('button', { name: 'Mit Passkey anmelden' });
		expect(screen.queryByRole('button', { name: 'Konto erstellen' })).toBeNull();
		expect(screen.queryByLabelText('Spitzname')).toBeNull();
		expect(screen.getByText(/Du meldest dich mit einem Passkey an/)).toBeDefined();
		expect(screen.queryByRole('heading', { name: 'Neu hier?' })).toBeNull();
	});

	// [D-241] SHOPPINGLIST_SIGNUP=invite: the create-account half needs a link.
	describe('on an invite-only instance', () => {
		beforeEach(() => {
			vi.mocked(fetchAuthMethods).mockResolvedValue(
				defaultAuthMethods({ passkeys: { signup: false, signup_by_link: true } })
			);
		});

		it('says how to get in instead of offering an account it would refuse', async () => {
			await renderAuth();
			await screen.findByRole('button', { name: 'Mit Passkey anmelden' });
			expect(screen.queryByRole('button', { name: 'Konto erstellen' })).toBeNull();
			expect(screen.getByRole('heading', { name: 'Neu hier?' })).toBeDefined();
			expect(screen.getByRole('heading', { name: 'Schon ein Konto?' })).toBeDefined();
			expect(screen.getByText(/nur mit einem Einladungslink/)).toBeDefined();
		});

		it("creates the account with a list's invite and reports it", async () => {
			vi.mocked(register).mockResolvedValue(undefined);
			const onregistered = vi.fn();
			render(AuthScreen, { props: { invite: 'list-link', onregistered } });
			const field = await screen.findByLabelText('Spitzname');
			await fireEvent.input(field, { target: { value: 'Bob' } });
			await fireEvent.click(screen.getByRole('button', { name: 'Konto erstellen und beitreten' }));
			await waitFor(() => expect(onregistered).toHaveBeenCalled());
			expect(vi.mocked(register)).toHaveBeenCalledWith('Bob', { invite: 'list-link' });
		});

		it('creates the first account with the setup link from the log', async () => {
			vi.mocked(setupToken).mockReturnValueOnce('from-the-log');
			vi.mocked(register).mockResolvedValue(undefined);
			await renderAuth();
			await fireEvent.input(screen.getByLabelText('Spitzname'), {
				target: { value: 'Alice' }
			});
			await fireEvent.click(screen.getByRole('button', { name: 'Konto erstellen' }));
			await waitFor(() => expect(vi.mocked(clearSetupToken)).toHaveBeenCalled());
			expect(vi.mocked(register)).toHaveBeenCalledWith('Alice', { setup: 'from-the-log' });
		});
	});

	it('is an OIDC-only screen while passkeys are off', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({
				passkeys: { enabled: false, signup: false },
				oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' }
			})
		);
		await renderAuth();
		expect(await screen.findByRole('button', { name: 'Weiter mit Keycloak' })).toBeDefined();
		expect(screen.getByText(/Beim ersten Mal wird dein Konto erstellt/)).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Mit Passkey anmelden' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Konto erstellen' })).toBeNull();
		// Not the "this browser cannot do passkeys" screen: the browser can,
		// the instance does not use them.
		expect(screen.queryByText('Passkeys nicht unterstützt')).toBeNull();
		// No background passkey ceremony on an instance without passkeys.
		expect(vi.mocked(login)).not.toHaveBeenCalled();
	});

	it('offers a retry when the sign-in options cannot be loaded', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValueOnce(null);
		await renderAuth();
		expect(await screen.findByRole('alert')).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Mit Passkey anmelden' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
		expect(await screen.findByRole('button', { name: 'Mit Passkey anmelden' })).toBeDefined();
	});
});
