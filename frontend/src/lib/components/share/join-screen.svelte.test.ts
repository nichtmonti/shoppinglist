// §7.6 join/preview flow. Follows the harness pattern documented in
// src/lib/components/auth/auth-screen.svelte.test.ts: mock #lib/actions/lists
// (previewInvite/joinList are transactional pb.send calls, not Dexie reads)
// and #lib/auth (authState) the way that file mocks the whole auth module,
// and $app/navigation + $app/paths the way lists-home.svelte.test.ts does.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { ClientResponseError } from 'pocketbase';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});
vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock(
		// The join flow has no autofill anchor on this screen's fields.
		{ canUsePasskeyAutofill: vi.fn(async () => false) },
		{ isValid: true }
	);
});

vi.mock('#lib/actions/lists.js', () => ({
	previewInvite: vi.fn(),
	joinList: vi.fn(),
	leaveList: vi.fn(),
	renameList: vi.fn(),
	createList: vi.fn()
}));

import { goto } from '$app/navigation';
import { authState, fetchAuthMethods, login, oidcLogin, register } from '#lib/auth/index.js';
import { defaultAuthMethods } from '#lib/test-kit/auth-mock.js';
import { refreshAuthMethods } from '#lib/state/auth-methods.js';
import { previewInvite, joinList } from '#lib/actions/lists.js';
import * as appState from '#lib/test-kit/app-state.svelte.js';
import JoinScreen from './JoinScreen.svelte';
import { joinToken } from './join-token';

const auth = authState as unknown as {
	set(v: { nickname: string | null; isValid: boolean }): void;
};

beforeEach(() => {
	vi.clearAllMocks();
	auth.set({ nickname: null, isValid: true });
	window.location.hash = '';
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('JoinScreen', () => {
	it('shows the preview for a valid token and joins on click', async () => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: [{ name: 'Milch', name_de: null, name_en: null, quantity: '2' }],
			member_count: 3
		});
		vi.mocked(joinList).mockResolvedValue('list-42');

		render(JoinScreen);

		await waitFor(() => {
			expect(vi.mocked(previewInvite)).toHaveBeenCalledWith('good-token');
			expect(screen.getByText('Familieneinkauf')).toBeDefined();
			expect(screen.getByText('1 Artikel · 3 Mitglieder')).toBeDefined();
			expect(screen.getByText('Milch')).toBeDefined();
		});

		// No per-member name to choose any more ([D-08]): the screen has no text field.
		expect(screen.queryByRole('textbox')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Beitreten' }));

		await waitFor(() => {
			// [D-08] the token is all a join sends: the list's name is the list's.
			expect(vi.mocked(joinList)).toHaveBeenCalledWith('good-token');
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/list/list-42', {
				replace: true,
				state: {},
				persistState: true
			});
		});
	});

	// [D-230]: the joined list takes the join screen's place in history. Its
	// token is gone from the URL by then, so back to it could only have said
	// the invitation is invalid.
	it('leaves no join screen behind the joined list for back to land on', async () => {
		appState.resetHistory('/join');
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({ name: 'Familie', items: [], member_count: 1 });
		vi.mocked(joinList).mockResolvedValue('list-42');

		render(JoinScreen);
		await fireEvent.click(await screen.findByRole('button', { name: 'Beitreten' }));

		await waitFor(() =>
			expect(appState.historyEntries()).toEqual({ urls: ['/list/list-42'], index: 0 })
		);
		// The token has let this account in; the tab forgets it. The join
		// replaced the entry, which the kit's history does not do to the address.
		window.location.hash = '';
		expect(joinToken()).toBe('');
	});

	// [D-295] It stays until the join, so „Open in Safari" from an in-app
	// browser carries it on; the join replaces the entry.
	it('leaves the invite token in the address bar until the join', async () => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: [],
			member_count: 1
		});

		render(JoinScreen);

		await waitFor(() => {
			expect(vi.mocked(previewInvite)).toHaveBeenCalledWith('good-token');
		});
		expect(window.location.hash).toBe('#good-token');
	});

	// The shell recreates this screen on a language switch ({#key $localePref}),
	// after the fragment is gone.
	it('keeps the invitation when the screen is remounted', async () => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({ name: 'Familie', items: [], member_count: 1 });

		const { unmount } = render(JoinScreen);
		await screen.findByText('Familie');
		unmount();
		render(JoinScreen);

		await screen.findByText('Familie');
		expect(vi.mocked(previewInvite)).toHaveBeenLastCalledWith('good-token');
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('hard-navigates instead of showing the invalid-link message when goto rejects', async () => {
		// replace, not assign: the joined list takes the join screen's entry.
		const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: [{ name: 'Milch', name_de: null, name_en: null, quantity: '2' }],
			member_count: 3
		});
		vi.mocked(joinList).mockResolvedValue('list-42');
		vi.mocked(goto).mockRejectedValueOnce(new Error('SPA navigation failed'));

		render(JoinScreen);

		await screen.findByText('Familieneinkauf');

		await fireEvent.click(screen.getByRole('button', { name: 'Beitreten' }));

		await waitFor(() => {
			expect(replace).toHaveBeenCalledWith('/list/list-42');
		});
		// The join succeeded server-side; a failed SPA navigation must not read
		// as a failed join, so no §7.6 generic message may render.
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows the generic invalid message for a bad token, without distinguishing why', async () => {
		window.location.hash = 'bad-token';
		vi.mocked(previewInvite).mockRejectedValue(
			new ClientResponseError({ status: 400, response: { message: 'invalid invite' } })
		);

		render(JoinScreen);

		await waitFor(() => {
			expect(
				screen.getByText('Diese Einladung ist ungültig, abgelaufen oder zurückgezogen.')
			).toBeDefined();
		});
		expect(screen.queryByRole('button', { name: 'Beitreten' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
	});

	it('leads from a dead invitation to the lists, or to the sign-in for a visitor', async () => {
		appState.resetHistory('/join');
		window.location.hash = 'bad-token';
		vi.mocked(previewInvite).mockRejectedValue(
			new ClientResponseError({ status: 400, response: { message: 'invalid invite' } })
		);
		auth.set({ nickname: 'Ben', isValid: true });
		const { unmount } = render(JoinScreen);
		await fireEvent.click(await screen.findByRole('button', { name: 'Zu meinen Listen' }));
		// In place of the dead link, which back would only show again.
		await waitFor(() => expect(appState.historyEntries()).toEqual({ urls: ['/'], index: 0 }));
		window.location.hash = '';
		expect(joinToken()).toBe('');
		unmount();

		window.location.hash = 'bad-token';
		auth.set({ nickname: null, isValid: false });
		render(JoinScreen);
		expect(await screen.findByRole('button', { name: 'Zur Anmeldung' })).toBeDefined();
	});

	// [D-292] Only the server's refusal says the link is dead; a request that
	// never got that answer offers to try again.
	it('offers a retry, not the invalid message, when the preview cannot reach the server', async () => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite)
			.mockRejectedValueOnce(new ClientResponseError({ status: 0 }))
			.mockResolvedValueOnce({ name: 'Familie', items: [], member_count: 1 });

		render(JoinScreen);

		await screen.findByText(
			'Das hat gerade nicht geklappt. Prüfe die Verbindung und versuch es noch einmal.'
		);
		expect(screen.queryByText(/ungültig/)).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

		await screen.findByText('Familie');
		expect(vi.mocked(previewInvite)).toHaveBeenLastCalledWith('good-token');
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('keeps the preview and the join button when the join cannot reach the server', async () => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({ name: 'Familie', items: [], member_count: 1 });
		vi.mocked(joinList)
			.mockRejectedValueOnce(new ClientResponseError({ status: 503 }))
			.mockResolvedValueOnce('list-42');

		render(JoinScreen);
		await fireEvent.click(await screen.findByRole('button', { name: 'Beitreten' }));

		await screen.findByText(
			'Das hat gerade nicht geklappt. Prüfe die Verbindung und versuch es noch einmal.'
		);
		expect(screen.getByText('Familie')).toBeDefined();

		await fireEvent.click(screen.getByRole('button', { name: 'Beitreten' }));
		await waitFor(() => expect(vi.mocked(goto)).toHaveBeenCalled());
		expect(vi.mocked(joinList)).toHaveBeenCalledTimes(2);
	});

	it('prompts to create an account first when signed out', async () => {
		auth.set({ nickname: null, isValid: false });
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: [],
			member_count: 1
		});

		render(JoinScreen);

		await waitFor(() => {
			expect(screen.getByText('Zum Beitreten brauchst du ein Konto.')).toBeDefined();
		});
		expect(screen.queryByRole('button', { name: 'Beitreten' })).toBeNull();
	});

	it('names the first few items and counts the rest', async () => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: ['Milch', 'Brot', 'Äpfel', 'Eier', 'Butter', 'Käse', 'Reis'].map((name) => ({
				name,
				name_de: null,
				name_en: null,
				quantity: ''
			})),
			member_count: 2
		});

		render(JoinScreen);

		expect(await screen.findByText('Milch, Brot, Äpfel, Eier, Butter und 2 weitere')).toBeDefined();
		expect(screen.getByText('7 Artikel · 2 Mitglieder')).toBeDefined();
	});

	// [D-265] A visitor holding an invite is most likely new: the new account
	// comes first and is the filled button, under the join screen's one title
	// and without the auth screen's passkey intro.
	it('puts the new account before sign-in, under its own title', async () => {
		auth.set({ nickname: null, isValid: false });
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: [],
			member_count: 1
		});

		render(JoinScreen);

		const create = await screen.findByRole('button', { name: 'Konto erstellen und beitreten' });
		const signIn = screen.getByRole('button', { name: 'Mit Passkey anmelden' });
		expect(create.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
		expect(screen.getAllByTestId('auth-locale')).toHaveLength(1);
		expect(screen.queryByText(/Hier gibt es kein Passwort/)).toBeNull();
	});

	// [D-297] iOS opens the link in Safari, which does not know someone who
	// uses the installed app: the sign-in half speaks to them by that.
	it('tells someone who already uses the app that signing in is theirs', async () => {
		auth.set({ nickname: null, isValid: false });
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue({ name: 'Familie', items: [], member_count: 1 });

		render(JoinScreen);

		expect(await screen.findByRole('heading', { name: 'Du nutzt die App schon?' })).toBeDefined();
		expect(screen.getByText('Melde dich mit deinem Passkey an.')).toBeDefined();
		expect(screen.queryByRole('heading', { name: 'Schon ein Konto?' })).toBeNull();
	});
});

// [D-241] On an invite-only instance the invite link is the way in: the
// visitor creates the account with the link's token, and the join then opens
// the list the server already put them on.
describe('JoinScreen — signing up through the invite', () => {
	it("creates the account with the link's token, then joins and opens the list", async () => {
		auth.set({ nickname: null, isValid: false });
		window.location.hash = 'family-link';
		vi.mocked(fetchAuthMethods).mockResolvedValue(
			defaultAuthMethods({ passkeys: { signup: false, signup_by_link: true } })
		);
		vi.mocked(previewInvite).mockResolvedValue({
			name: 'Familieneinkauf',
			items: [],
			member_count: 2
		});
		vi.mocked(register).mockImplementation(async () => {
			auth.set({ nickname: 'Bob', isValid: true });
		});
		vi.mocked(joinList).mockResolvedValue('list-42');

		render(JoinScreen);
		const field = await screen.findByLabelText('Spitzname');
		await fireEvent.input(field, { target: { value: 'Bob' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Konto erstellen und beitreten' }));

		await waitFor(() => expect(vi.mocked(joinList)).toHaveBeenCalledWith('family-link'));
		expect(vi.mocked(register)).toHaveBeenCalledWith('Bob', { invite: 'family-link' });
		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/list/list-42', expect.anything())
		);
	});
});

// §5.8 draws THREE states, not two: `isValid` is a live session, but a device
// that has ever signed in keeps `nickname` set after its token expires. An
// expired-but-known device must get the one-tap re-auth, not <AuthScreen> —
// "create account" there would mint a second account and swap the session
// underneath the first.
describe('JoinScreen — an expired session on a known device', () => {
	const preview = {
		name: 'Familieneinkauf',
		items: [],
		member_count: 2
	};

	beforeEach(() => {
		window.location.hash = 'good-token';
		vi.mocked(previewInvite).mockResolvedValue(preview);
	});

	it('offers re-auth instead of the create-account screen', async () => {
		auth.set({ nickname: 'Anna', isValid: false });
		render(JoinScreen);

		await waitFor(() =>
			expect(
				screen.getByText('Deine Sitzung ist abgelaufen. Melde dich erneut an, um beizutreten.')
			).toBeDefined()
		);
		// The whole point: no route to a duplicate account from here.
		expect(screen.queryByRole('button', { name: 'Konto erstellen und beitreten' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Erneut anmelden' }));
		expect(vi.mocked(login)).toHaveBeenCalled();
	});

	// [D-76]: an instance without passkeys cannot run a passkey ceremony, so
	// the re-auth must be the instance's OIDC login.
	it('re-authenticates through OIDC on an OIDC-only instance', async () => {
		vi.mocked(fetchAuthMethods).mockResolvedValueOnce(
			defaultAuthMethods({
				passkeys: { enabled: false, signup: false },
				oidc: { enabled: true, provider: 'oidc', name: 'Dex' }
			})
		);
		await refreshAuthMethods();
		auth.set({ nickname: 'Anna', isValid: false });
		render(JoinScreen);

		await fireEvent.click(await screen.findByRole('button', { name: 'Erneut anmelden' }));

		// No session record in this harness, so no account to hold it to.
		expect(vi.mocked(oidcLogin)).toHaveBeenCalledWith('oidc', { expectAccount: undefined });
		expect(vi.mocked(login)).not.toHaveBeenCalled();
	});

	it('still shows the create-account screen to a genuine visitor', async () => {
		auth.set({ nickname: null, isValid: false });
		render(JoinScreen);

		expect(
			await screen.findByRole('button', { name: 'Konto erstellen und beitreten' })
		).toBeDefined();
	});

	it('shows the join form once the session is valid again', async () => {
		auth.set({ nickname: 'Anna', isValid: true });
		render(JoinScreen);

		expect(await screen.findByRole('button', { name: 'Beitreten' })).toBeDefined();
	});
});
