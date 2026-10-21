// Pins the register()/addPasskey() distinction (§5.4 "multiple passkeys per
// account"). Both start a WebAuthn registration ceremony against
// /api/passkey/register/begin, but the server (backend/internal/webauthn/
// handlers.go registerBegin) only adds the credential to the CALLER's account
// — instead of minting a brand-new anonymous one — when the request carries a
// valid Authorization header. Reusing register() for "add backup passkey"
// would silently create a second account every time.
import { ClientResponseError } from 'pocketbase';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted(() => ({
	isValid: false,
	token: '',
	record: null as { id: string; nickname?: string } | null,
	onChange: vi.fn(),
	save: vi.fn(),
	clear: vi.fn()
}));

const send = vi.hoisted(() => vi.fn());
const cancelCeremony = vi.hoisted(() => vi.fn());

const oidcCollection = vi.hoisted(() => ({
	authWithOAuth2: vi.fn()
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		authStore,
		collections: { accounts: oidcCollection },
		send,
		pb: { baseURL: '/', cancelRequest: vi.fn() }
	});
});

// linkOidc() runs its popup exchange on a client of its own; every one it
// builds is recorded here, with a real in-memory store and the same collection
// stub as `pb`.
const linkClients = vi.hoisted(
	() =>
		[] as {
			authStore: import('pocketbase').BaseAuthStore;
			cancelRequest: () => void;
			send: ReturnType<typeof vi.fn>;
		}[]
);
vi.mock('pocketbase', async (importOriginal) => {
	const actual = await importOriginal<typeof import('pocketbase')>();
	// The real client, with the OIDC collection and cancelRequest faked: its
	// send goes through the stubbed fetch, as the passkey ceremonies' does.
	class LinkClient extends actual.default {
		override cancelRequest = vi.fn();
		override send = vi.fn((path: string, options?: object) =>
			actual.default.prototype.send.call(this, path, options ?? {})
		) as unknown as InstanceType<typeof actual.default>['send'];
		override collection = (() => oidcCollection) as unknown as InstanceType<
			typeof actual.default
		>['collection'];
		constructor(baseURL: string, store: import('pocketbase').BaseAuthStore) {
			super(baseURL, store);
			linkClients.push(this as unknown as (typeof linkClients)[number]);
		}
	}
	return { ...actual, default: LinkClient };
});

vi.mock('#lib/i18n/index.js', () => ({
	t: (key: string) => key
}));

// Dexie is real in db.test.ts (which pins what the wipe actually clears); here
// it is mocked so logout() can be asserted as "hands off to the wipe" without
// standing up an IndexedDB in the node project.
vi.mock('#lib/auth/account-data.js', () => ({
	wipeLocalAccountData: vi.fn(async () => {}),
	deleteLocalDatabase: vi.fn(async () => {})
}));

vi.mock('@simplewebauthn/browser', () => ({
	browserSupportsWebAuthn: vi.fn(() => true),
	startRegistration: vi.fn(async () => ({ id: 'cred-1' })),
	startAuthentication: vi.fn(),
	sendSignal: vi.fn(async () => undefined),
	WebAuthnAbortService: { cancelCeremony }
}));

import { sendSignal, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { deleteLocalDatabase, wipeLocalAccountData } from '#lib/auth/account-data.js';
import {
	addPasskey,
	authState,
	cancelConditionalLogin,
	cachedAuthMethods,
	fetchAuthMethods,
	isAutofillUnsupported,
	isCeremonyDismissal,
	lastLoginMethod,
	linkOidc,
	oidcLogin,
	login,
	logout,
	refreshOnStart,
	register,
	unlinkOidc,
	WrongAccountError
} from './index';
import { endSession } from './session';
import { t } from '#lib/i18n/index.js';

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

beforeEach(() => {
	authStore.isValid = false;
	authStore.token = '';
	authStore.record = null;
	// Module state shared across every test in this file (the auth screen's
	// nickname draft) — each test starts from an empty one.
	// This file runs in the `server` (node) vitest project — plain .test.ts files
	// never run under happy-dom (see vite.config.ts's client-project include pattern,
	// which is svelte-test-only) — so browserId()'s localStorage read needs a
	// minimal stub. Not real persistence: each test gets a fresh empty store.
	const store = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value)
	});
	// The SDK's OAuth2 flow, popup included, is stubbed: authWithOAuth2's
	// mock implementation is set per-test.
	oidcCollection.authWithOAuth2.mockReset();
	send.mockReset();
	authStore.save.mockClear();
	authState.set({ nickname: null, isValid: false });
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			return jsonResponse({
				publicKey: {},
				token: 'new-token',
				record: { id: 'acct-1' },
				ok: true,
				// echoed back so the test can inspect what was actually sent
				_authHeader: headers.get('Authorization')
			});
		})
	);
});

describe('refreshOnStart() — persisted session verification', () => {
	it('expires a rejected token without discarding its account identity', async () => {
		authStore.isValid = true;
		authStore.record = { id: 'acct-1', nickname: 'Anna' };
		send.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));

		await refreshOnStart();

		let state = { nickname: null as string | null, isValid: true };
		const unsubscribe = authState.subscribe((value) => (state = value));
		unsubscribe();
		expect(state).toEqual({ nickname: 'Anna', isValid: false });
	});

	it('keeps an unexpired local session readable through a network failure', async () => {
		authStore.isValid = true;
		authStore.record = { id: 'acct-1', nickname: 'Anna' };
		send.mockRejectedValue(Object.assign(new Error('network unavailable'), { status: 0 }));

		await refreshOnStart();

		let state = { nickname: null as string | null, isValid: false };
		const unsubscribe = authState.subscribe((value) => (state = value));
		unsubscribe();
		expect(state).toEqual({ nickname: 'Anna', isValid: true });
	});
});

describe('refreshOnStart() — a sign-out during the refresh', () => {
	it('does not save the refreshed token once the session has ended', async () => {
		authStore.isValid = true;
		authStore.record = { id: 'acct-1', nickname: 'Anna' };
		let respond: (v: unknown) => void = () => {};
		send.mockImplementation(() => new Promise((r) => (respond = r)));

		const refreshing = refreshOnStart();
		await vi.waitFor(() => expect(send).toHaveBeenCalled());
		// The user signs out while the request is in flight...
		endSession();
		// ...and only then does the refreshed token arrive.
		respond({ token: 'refreshed', record: { id: 'acct-1' } });
		await refreshing;

		expect(authStore.save).not.toHaveBeenCalled();
	});

	it('saves the refreshed token while the session is current', async () => {
		authStore.isValid = true;
		authStore.record = { id: 'acct-1', nickname: 'Anna' };
		send.mockResolvedValue({ token: 'refreshed', record: { id: 'acct-1' } });

		await refreshOnStart();

		expect(authStore.save).toHaveBeenCalledWith('refreshed', { id: 'acct-1' });
	});
});

describe('register() — signed-out registration', () => {
	it('never sends an Authorization header, even when a stale session exists', async () => {
		authStore.isValid = true;
		authStore.token = 'stale-token';

		await register('Anna');

		const fetchMock = vi.mocked(fetch);
		for (const call of fetchMock.mock.calls) {
			const headers = new Headers(call[1]?.headers);
			expect(headers.get('Authorization')).toBeNull();
		}
	});

	// A 403 from register/begin is the server's signup gate
	// (SHOPPINGLIST_SIGNUP=closed, backend/internal/webauthn/handlers.go), a
	// standing state rather than a transient failure. It must not be flattened
	// into the generic "could not be started" message, which reads as "try
	// again" for something that never will.
	it('reports a closed instance distinctly from a failed begin', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({}, 403))
		);

		await expect(register('Anna')).rejects.toThrow('auth_register_closed');
	});

	it('still reports a non-403 begin failure generically', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({}, 500))
		);

		await expect(register('Anna')).rejects.toThrow('auth_register_begin_failed');
	});
});

describe('addPasskey() — add a passkey to the current account', () => {
	it('sends the current session token as Authorization on the begin request', async () => {
		authStore.isValid = true;
		authStore.token = 'session-token';

		await addPasskey('iPhone');

		const fetchMock = vi.mocked(fetch);
		// The test only ever calls fetch with a plain string URL (auth/passkey.ts never
		// passes a Request/URL object) — assert that rather than fighting
		// no-base-to-string over the wider RequestInfo union.
		const beginCall = fetchMock.mock.calls.find(([url]) =>
			(url as string).includes('/register/begin')
		);
		expect(beginCall).toBeDefined();
		const headers = new Headers(beginCall?.[1]?.headers);
		expect(headers.get('Authorization')).toBe('Bearer session-token');
		// The friendly_name is sent in the begin body so the server can stash
		// it in the session and persist it on the credential at finish.
		const beginBody = JSON.parse(beginCall?.[1]?.body as string);
		expect(beginBody.friendly_name).toBe('iPhone');
	});

	// finishCeremony()'s login/new-account finish never needs this header, but
	// resolveRegistrationUser (backend/internal/webauthn/handlers.go)
	// re-asserts e.Auth.Id == the session's account for the add-passkey
	// branch, and PocketBase resolves e.Auth from this header alone (no
	// cookie fallback). Without it, e.Auth is nil on every finish call and
	// adding a second passkey to an existing account fails with
	// "session not found or expired".
	it('sends the current session token as Authorization on the finish request too', async () => {
		authStore.isValid = true;
		authStore.token = 'session-token';

		await addPasskey('iPhone');

		const fetchMock = vi.mocked(fetch);
		const finishCall = fetchMock.mock.calls.find(([url]) =>
			(url as string).includes('/register/finish')
		);
		expect(finishCall).toBeDefined();
		const headers = new Headers(finishCall?.[1]?.headers);
		expect(headers.get('Authorization')).toBe('Bearer session-token');
	});

	// A token revoked elsewhere still looks valid here; the server answers 401
	// (it used to open a NEW account), and the session shows as expired.
	it('a 401 from begin marks the session expired and starts no ceremony', async () => {
		authStore.isValid = true;
		authStore.token = 'revoked-token';
		authStore.record = { id: 'acc1', nickname: 'Anna' };
		authState.set({ nickname: 'Anna', isValid: true });
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, 401));

		const ceremonies = vi.mocked(startRegistration).mock.calls.length;
		await expect(addPasskey('iPhone')).rejects.toThrow('auth_not_authenticated');
		expect(vi.mocked(startRegistration).mock.calls.length).toBe(ceremonies);
		let state = { isValid: true };
		authState.subscribe((value) => (state = value))();
		expect(state.isValid).toBe(false);
	});

	it('refuses to run without a valid session', async () => {
		authStore.isValid = false;
		authStore.token = '';

		await expect(addPasskey('iPhone')).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('does not touch pb.authStore.save (unlike register/login) — the finish response carries no token', async () => {
		authStore.isValid = true;
		authStore.token = 'session-token';

		await addPasskey('iPhone');

		// addPasskey's finish response is {ok:true}, not {token,record} — if it were
		// ever routed through finishCeremony's pb.authStore.save(data.token, ...),
		// authStore.token would be overwritten with `undefined` here.
		expect(authStore.token).toBe('session-token');
	});
});

describe('ceremony error classification', () => {
	it('maps NotAllowedError to the cancelled message', async () => {
		authStore.isValid = true;
		authStore.token = 'session-token';
		const cancelled = new Error('The operation either timed out or was not allowed.');
		cancelled.name = 'NotAllowedError';
		vi.mocked(startRegistration).mockRejectedValueOnce(cancelled);

		await expect(addPasskey('iPhone')).rejects.toThrow('auth_ceremony_cancelled');
	});

	it('maps AbortError to the cancelled message', async () => {
		// @simplewebauthn/browser auto-aborts a prior ceremony when a new one
		// starts; this shares the NotAllowedError branch but is a distinct
		// DOMException name, so it gets its own case.
		authStore.isValid = true;
		authStore.token = 'session-token';
		const aborted = new Error('The operation was aborted.');
		aborted.name = 'AbortError';
		vi.mocked(startRegistration).mockRejectedValueOnce(aborted);

		await expect(addPasskey('iPhone')).rejects.toThrow('auth_ceremony_cancelled');
	});

	it('maps InvalidStateError to the already-registered message', async () => {
		authStore.isValid = true;
		authStore.token = 'session-token';
		const dup = new Error('The authenticator already has this credential registered.');
		dup.name = 'InvalidStateError';
		vi.mocked(startRegistration).mockRejectedValueOnce(dup);

		await expect(addPasskey('iPhone')).rejects.toThrow('auth_ceremony_already_registered');
	});

	it('lets unrecognised errors fall through to the generic message', async () => {
		authStore.isValid = true;
		authStore.token = 'session-token';
		vi.mocked(startRegistration).mockRejectedValueOnce(new Error('something unexpected'));

		await expect(addPasskey('iPhone')).rejects.toThrow('auth_add_passkey_failed');
	});

	it('lets non-Error throws fall through without crashing on .name', async () => {
		// classifyCeremonyError guards on `e instanceof Error` before reading
		// .name; a string (or null) throw must not crash it.
		authStore.isValid = true;
		authStore.token = 'session-token';
		vi.mocked(startRegistration).mockRejectedValueOnce('a bare string');

		await expect(addPasskey('iPhone')).rejects.toThrow('auth_add_passkey_failed');
	});
});

// §5.8: a device that has ever signed in keeps its auth RECORD until logout()
// clears it — only the TOKEN expires. So `record` being set is the signal that
// this device already has an account, and register() would mint a second one.
// The server cannot make this call for us: registerBegin sees an
// unauthenticated request (register() never sends the header, by design — see
// the first test in this file) and cannot tell it apart from a genuine signup.
describe('register() — an account already on this device', () => {
	it('refuses rather than silently minting a second account', async () => {
		authStore.record = { id: 'acct-1', nickname: 'Anna' };

		await expect(register('Anna')).rejects.toThrow('auth_already_have_account');
		expect(fetch).not.toHaveBeenCalled();
	});

	// The expired-token case: `isValid` false but a record still present is a
	// device that has an account, so a new registration would be a second one.
	it('refuses on an expired session too, not just a live one', async () => {
		authStore.isValid = false;
		authStore.token = '';
		authStore.record = { id: 'acct-1', nickname: 'Anna' };

		await expect(register('Anna')).rejects.toThrow('auth_already_have_account');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('still registers normally once logout() has cleared the record', async () => {
		authStore.record = null;

		await expect(register('Anna')).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalled();
	});
});

describe('logout()', () => {
	it('drops the local account mirror, not just the token', async () => {
		authStore.record = { id: 'acct-1', nickname: 'Anna' };

		await logout();

		expect(authStore.clear).toHaveBeenCalled();
		expect(vi.mocked(wipeLocalAccountData)).toHaveBeenCalled();
	});

	// Ordering is load-bearing: clearing the auth store first means every
	// in-flight request goes out unauthenticated (and the shell unmounts the
	// sync loop) BEFORE the mirror is dropped, so a cycle mid-flight cannot
	// write the old account's rows back in behind the wipe.
	it('clears the session before wiping', async () => {
		const order: string[] = [];
		authStore.clear.mockImplementation(() => void order.push('clear'));
		vi.mocked(wipeLocalAccountData).mockImplementation(async () => void order.push('wipe'));

		await logout();

		expect(order).toEqual(['clear', 'wipe']);
	});

	// A failed wipe must not leave the account's lists to the next account:
	// the whole database goes, and the page starts again on an empty one.
	it('deletes the whole local database when the wipe fails', async () => {
		vi.mocked(wipeLocalAccountData).mockRejectedValueOnce(new Error('QuotaExceededError'));
		const reload = vi.fn();
		vi.stubGlobal('location', { pathname: '/settings', reload });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 204 }))
		);

		await logout();

		expect(vi.mocked(deleteLocalDatabase)).toHaveBeenCalled();
		expect(reload).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

// linkOidc() builds its Authorization header BY HAND (the raw fetch() to
// /api/account/link — backend/internal/account/link.go requires the current
// account's identity on the request), the same bug class as addPasskey's
// finish request.
describe('linkOidc() — attach the OIDC login to the current account', () => {
	// What the real SDK does on the link client: the exchange signs its store in.
	function exchangeSignsInLinkClient() {
		oidcCollection.authWithOAuth2.mockImplementation(async () => {
			linkClients.at(-1)!.authStore.save('oidc-token', { id: 'acct-oidc' } as never);
		});
	}

	beforeEach(() => {
		linkClients.length = 0;
		send.mockResolvedValue({});
		authStore.isValid = true;
		authStore.token = 'passkey-token';
		authStore.record = { id: 'acct-passkey' };
	});

	it('sends the session token as Authorization and the fresh OIDC token in the body', async () => {
		exchangeSignsInLinkClient();

		await linkOidc('google');

		expect(send).toHaveBeenCalledWith('/api/account/link', {
			method: 'POST',
			headers: { Authorization: 'Bearer passkey-token' },
			body: { token: 'oidc-token' }
		});
	});

	// [D-76]: the login is attached to this account, so the device keeps the
	// session it has; the OIDC token was only the proof, and the account it
	// named is gone.
	it('keeps the current session, before and after the link', async () => {
		exchangeSignsInLinkClient();
		let sharedTokenDuringLink: string | undefined;
		send.mockImplementationOnce(async () => {
			// Anything reading the shared store now — a sync cycle the popup's
			// closing refocus started — must still see this account.
			sharedTokenDuringLink = authStore.token;
			return {};
		});

		await expect(linkOidc('google')).resolves.toBe(true);

		expect(sharedTokenDuringLink).toBe('passkey-token');
		expect(authStore.save).not.toHaveBeenCalled();
		expect(authStore.token).toBe('passkey-token');
		expect(linkClients.at(-1)!.authStore.token).toBe('');
		expect(lastLoginMethod()).toBe('oidc');
	});

	it('does nothing when the popup flow is cancelled', async () => {
		// What the SDK rejects with when cancelOidcLogin aborts its request key.
		oidcCollection.authWithOAuth2.mockRejectedValue(
			new ClientResponseError({ isAbort: true, message: 'manually cancelled' })
		);

		await expect(linkOidc('google')).resolves.toBe(false);

		expect(send).not.toHaveBeenCalledWith('/api/account/link', expect.anything());
		expect(authStore.save).not.toHaveBeenCalled();
	});

	it('leaves the session in place if the link request fails', async () => {
		exchangeSignsInLinkClient();
		send.mockRejectedValueOnce(new ClientResponseError({ status: 500 }));

		await expect(linkOidc('google')).rejects.toThrow('settings_link_oidc_failed');

		expect(authStore.token).toBe('passkey-token');
		expect(authStore.save).not.toHaveBeenCalled();
	});

	// [D-76]: an OIDC account with lists or passkeys of its own is not
	// attached; the user is told why and what to do instead.
	it('says so when the OIDC login already belongs to an account in use (409)', async () => {
		exchangeSignsInLinkClient();
		send.mockRejectedValueOnce(new ClientResponseError({ status: 409 }));

		await expect(linkOidc('google')).rejects.toThrow('settings_link_oidc_in_use');

		expect(authStore.token).toBe('passkey-token');
		expect(authStore.save).not.toHaveBeenCalled();
	});
});

// [D-76]: a re-auth must land in the account this device holds. Its session
// reaches the shared store only once that is checked — saved first, a sync
// cycle in between would run as the other account over this one's local data.
describe('oidcLogin({ expectAccount }) — re-auth keeps the account', () => {
	function exchangeSignsIn(id: string, isNew = false) {
		oidcCollection.authWithOAuth2.mockImplementation(async () => {
			linkClients.at(-1)!.authStore.save(`token-${id}`, { id } as never);
			return { token: `token-${id}`, record: { id }, meta: { isNew } };
		});
	}

	beforeEach(() => {
		linkClients.length = 0;
		authStore.isValid = false; // expired
		authStore.token = 'expired-token';
		authStore.record = { id: 'acct-1' };
	});

	it('saves the session when the sign-in is the same account', async () => {
		exchangeSignsIn('acct-1');

		await expect(oidcLogin('oidc', { expectAccount: 'acct-1' })).resolves.toBe(true);

		expect(authStore.save).toHaveBeenCalledWith('token-acct-1', { id: 'acct-1' });
		expect(lastLoginMethod()).toBe('oidc');
	});

	it('refuses an account the sign-in just created, deletes it, and falls back to the passkey', async () => {
		exchangeSignsIn('acct-new', true);
		localStorage.setItem('einkaufsliste-last-login', 'oidc');

		const err = await oidcLogin('oidc', { expectAccount: 'acct-1' }).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(WrongAccountError);
		expect((err as InstanceType<typeof WrongAccountError>).orphan).toBe(true);
		expect(authStore.save).not.toHaveBeenCalled();
		// Deleted as ITSELF, by the client that holds its token — never with
		// this device's session.
		const client = linkClients.at(-1)!;
		expect(client.authStore.token).toBe('token-acct-new');
		expect(client.send).toHaveBeenCalledWith('/api/account/delete', { method: 'POST' });
		expect(send).not.toHaveBeenCalledWith('/api/account/delete', expect.anything());
		expect(lastLoginMethod()).toBe('passkey');
	});

	it('refuses an existing other account and leaves it alone', async () => {
		exchangeSignsIn('acct-other', false);
		localStorage.setItem('einkaufsliste-last-login', 'oidc');

		const err = await oidcLogin('oidc', { expectAccount: 'acct-1' }).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(WrongAccountError);
		expect((err as InstanceType<typeof WrongAccountError>).orphan).toBe(false);
		expect(authStore.save).not.toHaveBeenCalled();
		expect(linkClients.at(-1)!.send).not.toHaveBeenCalled();
		expect(lastLoginMethod()).toBe('oidc');
	});

	it('resolves false and saves nothing when cancelled', async () => {
		oidcCollection.authWithOAuth2.mockRejectedValue(
			new ClientResponseError({ isAbort: true, message: 'manually cancelled' })
		);

		await expect(oidcLogin('oidc', { expectAccount: 'acct-1' })).resolves.toBe(false);
		expect(authStore.save).not.toHaveBeenCalled();
	});
});

describe('login() — a refused begin', () => {
	it('says sign-in could not be started, not that the passkey failed', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: 'too many' }, 429));

		await expect(login()).rejects.toThrow('auth_login_begin_failed');
	});
});

describe('login({ expectAccount }) — passkey re-auth keeps the account', () => {
	beforeEach(() => {
		authStore.record = { id: 'acct-1' };
	});

	it('saves the session when the passkey is this account’s', async () => {
		await login({ expectAccount: 'acct-1' });
		expect(authStore.save).toHaveBeenCalledWith('new-token', { id: 'acct-1' });
	});

	it('refuses another account’s passkey and keeps the session as it was', async () => {
		const err = await login({ expectAccount: 'acct-2' }).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(WrongAccountError);
		expect((err as InstanceType<typeof WrongAccountError>).orphan).toBe(false);
		expect(isCeremonyDismissal(err)).toBe(false);
		expect(authStore.save).not.toHaveBeenCalled();
	});
});

describe('unlinkOidc()', () => {
	it('posts the unlink and switches this device to the passkey', async () => {
		localStorage.setItem('einkaufsliste-last-login', 'oidc');
		send.mockResolvedValue({ ok: true });

		await unlinkOidc();

		expect(send).toHaveBeenCalledWith('/api/account/unlink', { method: 'POST' });
		expect(lastLoginMethod()).toBe('passkey');
	});

	it('names the missing passkey when the server refuses with 409', async () => {
		localStorage.setItem('einkaufsliste-last-login', 'oidc');
		send.mockRejectedValue(new ClientResponseError({ status: 409 }));

		await expect(unlinkOidc()).rejects.toThrow('settings_unlink_oidc_needs_passkey');
		expect(lastLoginMethod()).toBe('oidc');
	});

	it('reports any other failure generically', async () => {
		send.mockRejectedValue(new ClientResponseError({ status: 500 }));
		await expect(unlinkOidc()).rejects.toThrow('settings_unlink_oidc_failed');
	});
});

// login() re-throws a CLASSIFIED copy (classifyCeremonyError) whose own .name
// is just "Error" — the original DOMException name has to ride on .cause for
// AuthScreen's background ceremony to tell a user-driven non-completion
// (dismissed / superseded) from a real failure.
describe('isCeremonyDismissal()', () => {
	function named(name: string): Error {
		const e = new Error('ceremony');
		e.name = name;
		return e;
	}

	async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
		return p.then(
			() => null,
			(e: unknown) => e
		);
	}

	it('sees a dismissed dropdown (NotAllowedError) through the classified wrapper', async () => {
		vi.mocked(startAuthentication).mockRejectedValueOnce(named('NotAllowedError'));
		const err = await rejectionOf(login());
		expect(err).toBeInstanceOf(Error);
		expect(isCeremonyDismissal(err)).toBe(true);
	});

	it('sees a superseded ceremony (AbortError) through the classified wrapper', async () => {
		vi.mocked(startAuthentication).mockRejectedValueOnce(named('AbortError'));
		const err = await rejectionOf(login());
		expect(isCeremonyDismissal(err)).toBe(true);
	});

	it('does not call a failed finish a dismissal — the user engaged', async () => {
		// begin succeeds (default mock), the user picks a credential, /finish
		// fails: staying silent here would read as a dead button.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				String(url).includes('/login/finish')
					? jsonResponse({}, 500)
					: jsonResponse({ publicKey: {} })
			)
		);
		const err = await rejectionOf(login());
		expect(err).toBeInstanceOf(Error);
		expect(isCeremonyDismissal(err)).toBe(false);
	});

	// [D-293] A passkey removed from the account that the device still offers:
	// named, and the browser is asked to stop offering it.
	it('names a passkey the server no longer has, and asks the browser to forget it', async () => {
		vi.mocked(startAuthentication).mockResolvedValueOnce({ id: 'cred-gone' } as never);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				String(url).includes('/login/finish')
					? jsonResponse({}, 404)
					: jsonResponse({ publicKey: { rpId: 'example.test' } })
			)
		);

		const err = await rejectionOf(login());

		expect((err as Error).message).toBe(t('auth_passkey_unknown'));
		expect(isCeremonyDismissal(err)).toBe(false);
		await vi.waitFor(() =>
			expect(sendSignal).toHaveBeenCalledWith({
				signalName: 'unknownCredential',
				rpID: 'example.test',
				credentialID: 'cred-gone'
			})
		);
	});

	// Not a dismissal: a button press that hits it must still say so.
	it('tells a browser refusing autofill (NotSupportedError) from a dismissal', async () => {
		vi.mocked(startAuthentication).mockRejectedValueOnce(named('NotSupportedError'));
		const err = await rejectionOf(login({ conditional: true }));
		expect(isAutofillUnsupported(err)).toBe(true);
		expect(isCeremonyDismissal(err)).toBe(false);
		expect(isAutofillUnsupported(new Error('auth_login_begin_failed'))).toBe(false);
	});

	it('returns false for errors without a ceremonial cause', () => {
		expect(isCeremonyDismissal(new Error('auth_login_begin_failed'))).toBe(false);
		expect(isCeremonyDismissal('a bare string')).toBe(false);
	});

	// The race this guards: a background conditional login still inside its
	// /begin fetch when a button ceremony starts. Without the begin-fetch
	// signal, the background ceremony would reach navigator.credentials
	// second and the abort service would cancel the BUTTON's ceremony.
	it('a new ceremony aborts a background login still inside its begin fetch', async () => {
		let firstCall = true;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) =>
				firstCall
					? new Promise((_resolve, reject) => {
							firstCall = false;
							init?.signal?.addEventListener('abort', () => {
								reject(named('AbortError'));
							});
						})
					: Promise.resolve(
							jsonResponse({ publicKey: {}, token: 'new-token', record: { id: 'acct-1' } })
						)
			)
		);
		vi.mocked(startAuthentication).mockResolvedValue({ id: 'cred-1' } as Awaited<
			ReturnType<typeof startAuthentication>
		>);

		const background = login({ conditional: true });
		const foreground = login(); // its startCeremony() aborts the bg begin fetch

		const err = await rejectionOf(background);
		expect(isCeremonyDismissal(err)).toBe(true);
		await expect(foreground).resolves.toBeUndefined();
	});

	// A screen that leaves ends its background login, browser offer included,
	// but never a ceremony a button started since.
	it('cancelConditionalLogin ends the background login and only that', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) =>
				init?.signal
					? new Promise((_resolve, reject) =>
							init.signal?.addEventListener('abort', () => reject(named('AbortError')))
						)
					: Promise.resolve(jsonResponse({}))
			)
		);
		const background = login({ conditional: true });
		cancelConditionalLogin();
		expect(isCeremonyDismissal(await rejectionOf(background))).toBe(true);

		cancelCeremony.mockClear();
		const button = login();
		cancelConditionalLogin();
		expect(cancelCeremony).not.toHaveBeenCalled();
		const pending = vi.fn();
		void button.then(pending, pending);
		await new Promise((r) => setTimeout(r, 20));
		expect(pending).not.toHaveBeenCalled();
	});
});

// [D-76]: the instance's login methods, and the one per-account fact the
// cache must not keep.
describe('fetchAuthMethods() / cachedAuthMethods()', () => {
	const answer = {
		passkeys: { enabled: true, signup: false },
		oidc: { enabled: true, provider: 'oidc', name: 'Keycloak', linked: true, identity: 'anna' }
	};

	it('returns the server answer and caches it for offline, without `linked`', async () => {
		send.mockResolvedValue(answer);

		await expect(fetchAuthMethods()).resolves.toEqual(answer);

		expect(send).toHaveBeenCalledWith('/api/auth/methods', { requestKey: null });
		// `linked` and `identity` are one account's, not the instance's: a
		// device handed to someone else must not start out believing they are
		// linked, or show whom the last account was connected as.
		expect(cachedAuthMethods()).toEqual({
			passkeys: { enabled: true, signup: false },
			oidc: { enabled: true, provider: 'oidc', name: 'Keycloak' }
		});
		// The caller's answer keeps it.
		expect(answer.oidc.linked).toBe(true);
	});

	it('resolves null when the server cannot be asked, and keeps the last answer', async () => {
		send.mockResolvedValueOnce(answer);
		await fetchAuthMethods();
		send.mockRejectedValueOnce(new Error('offline'));

		await expect(fetchAuthMethods()).resolves.toBeNull();
		expect(cachedAuthMethods()?.passkeys.signup).toBe(false);
	});

	it('reads a missing or unreadable cache as "no answer yet"', () => {
		expect(cachedAuthMethods()).toBeNull();
		localStorage.setItem('einkaufsliste-auth-methods', '{not json');
		expect(cachedAuthMethods()).toBeNull();
		// What a response cut short used to leave behind.
		localStorage.setItem('einkaufsliste-auth-methods', '{"oidc":{}}');
		expect(cachedAuthMethods()).toBeNull();
	});
});

// [D-76]: the sync chip re-authenticates with the login this device last
// used, so a successful sign-in must record it and a cancelled one must not.
describe('lastLoginMethod()', () => {
	it('is unknown on a fresh device', () => {
		expect(lastLoginMethod()).toBeNull();
	});

	it('records a passkey sign-in', async () => {
		await login();
		expect(lastLoginMethod()).toBe('passkey');
	});

	it('records an OIDC sign-in, and a cancelled one leaves the last method alone', async () => {
		await login();
		oidcCollection.authWithOAuth2.mockRejectedValueOnce(
			new ClientResponseError({ isAbort: true, message: 'manually cancelled' })
		);
		await expect(oidcLogin('oidc')).resolves.toBe(false);
		expect(lastLoginMethod()).toBe('passkey');

		oidcCollection.authWithOAuth2.mockResolvedValueOnce(undefined);
		await expect(oidcLogin('oidc')).resolves.toBe(true);
		expect(lastLoginMethod()).toBe('oidc');
	});
});

// [D-209]: a refusal by this server's own exchange happens AFTER the provider
// accepted the user, so "the window was closed or the provider declined" sent
// the user looking in the wrong place. Anything else keeps the generic text.
describe('oidcLogin() — why it failed', () => {
	it("names the server's setup when the exchange itself is refused", async () => {
		oidcCollection.authWithOAuth2.mockRejectedValueOnce(
			new ClientResponseError({
				url: 'https://list.example.com/api/collections/accounts/auth-with-oauth2',
				status: 400,
				response: { message: 'Failed to fetch OAuth2 token.' }
			})
		);
		await expect(oidcLogin('oidc')).rejects.toThrow('auth_oidc_server_failed');
	});

	it('keeps the generic message for a failure before the exchange', async () => {
		oidcCollection.authWithOAuth2.mockRejectedValueOnce(
			new ClientResponseError({ status: 0, response: { message: 'realtime failed' } })
		);
		await expect(oidcLogin('oidc')).rejects.toThrow(/^auth_oidc_failed$/);
	});
});
