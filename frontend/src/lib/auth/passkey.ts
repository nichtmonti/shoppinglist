// Passkey registration / login ceremonies (§5.4) built on
// @simplewebauthn/browser, which is imported DYNAMICALLY at ceremony time so
// the app entry does not carry it on every boot.
import { authHeaders, pb } from '../pb';
import { markAuthExpired } from './state';
import { rememberLoginMethod } from './login-methods';
import { WrongAccountError } from './wrong-account';
import { readStored, writeStored } from '../safe-storage';
import { t } from '../i18n';
import { LocalizedError } from '../localized-error';

// Parallel ceremonies share one module promise; a rejected load clears it so a
// transient chunk-fetch failure does not poison passkeys until reload.
let webauthnModule: Promise<typeof import('@simplewebauthn/browser')> | null = null;
function loadWebauthn(): Promise<typeof import('@simplewebauthn/browser')> {
	return (webauthnModule ??= import('@simplewebauthn/browser').catch((err: unknown) => {
		webauthnModule = null;
		throw err;
	}));
}

// This browser's id, sent with every ceremony. With storage disabled it is a
// fresh id per ceremony, which the server accepts like any other.
function browserId(): string {
	let id = readStored('browser_id');
	if (!id) {
		id = crypto.randomUUID();
		writeStored('browser_id', id);
	}
	return id;
}

// WebAuthn allows ONE ceremony at a time. @simplewebauthn's abort service only
// covers navigator.credentials, so a background conditional login still inside
// its /begin fetch would reach credentials second and abort the button's
// ceremony. Every ceremony start aborts the previous controller, and every
// begin fetch carries its signal, so the newest ceremony always wins.
let activeCeremony: AbortController | null = null;
function startCeremony(): AbortController {
	activeCeremony?.abort();
	activeCeremony = new AbortController();
	return activeCeremony;
}

// The background conditional login's controller, while it is the active one.
let conditionalCeremony: AbortController | null = null;

/**
 * Ends the background conditional login, if it is still the ceremony under
 * way: its begin fetch, and the browser's autofill offer through the
 * library's abort service, which exists for a screen that leaves ([D-69]).
 * A ceremony a button started since is left alone.
 */
export function cancelConditionalLogin(): void {
	if (!conditionalCeremony || conditionalCeremony !== activeCeremony) return;
	conditionalCeremony.abort();
	conditionalCeremony = activeCeremony = null;
	void webauthnModule?.then(
		({ WebAuthnAbortService }) => WebAuthnAbortService.cancelCeremony(),
		() => {}
	);
}

export function canUsePasskeys(): boolean {
	// browserSupportsWebAuthn()'s core probe, without loading the library.
	return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

/**
 * Whether this browser can offer a DISCOVERABLE passkey in the autofill
 * dropdown ("conditional mediation"). Await it before
 * login({ conditional: true }).
 */
export async function canUsePasskeyAutofill(): Promise<boolean> {
	if (!canUsePasskeys()) return false;
	const { browserSupportsWebAuthnAutofill } = await loadWebauthn();
	return browserSupportsWebAuthnAutofill();
}

/**
 * Maps a WebAuthn ceremony error to a user-facing message, by the `.name` the
 * library's WebAuthnError keeps from the DOMException: NotAllowedError
 * (dismissed or timed out), AbortError (superseded by another ceremony, or
 * navigation), InvalidStateError (the authenticator already holds this
 * credential). null for anything else: the caller uses a generic message.
 */
function classifyCeremonyError(e: unknown): Error | null {
	const name = e instanceof Error ? e.name : '';
	if (name === 'NotAllowedError' || name === 'AbortError') {
		return new LocalizedError(t('auth_ceremony_cancelled'));
	}
	if (name === 'InvalidStateError') {
		return new LocalizedError(t('auth_ceremony_already_registered'));
	}
	return null;
}

/**
 * A passkey the server no longer has, removed in settings or with its account,
 * that the device still offers ([D-293]): retrying it never works.
 */
export class UnknownPasskeyError extends LocalizedError {}

/** Asks the browser to stop offering a passkey the server no longer has; a
 *  browser without the Signal API ignores it. */
function forgetPasskey(rpId: string | undefined, credentialId: string): void {
	void loadWebauthn()
		.then(({ sendSignal }) =>
			sendSignal({
				signalName: 'unknownCredential',
				rpID: rpId ?? location.hostname,
				credentialID: credentialId
			})
		)
		.catch(() => {});
}

async function finishCeremony(
	route: string,
	bid: string,
	response: unknown,
	expectAccount?: string,
	// A refusal the caller can name; null for the generic message.
	refused: (finish: Response) => Error | null = () => null
): Promise<void> {
	const finish = await fetch(route, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Browser-Id': bid },
		body: JSON.stringify(response)
	});
	if (!finish.ok) throw refused(finish) ?? new LocalizedError(t('auth_ceremony_failed'));
	const data = (await finish.json()) as {
		token: string;
		record: Parameters<typeof pb.authStore.save>[1];
	};
	// A re-auth that picked another account's passkey (a shared device) is not
	// kept: it would sync as that account over this one's local data ([D-76]).
	if (expectAccount && data.record?.id !== expectAccount) throw new WrongAccountError(false);
	pb.authStore.save(data.token, data.record);
	rememberLoginMethod('passkey');
}

/**
 * The shared first half of register() and addPasskey(): register/begin and the
 * browser ceremony. Resolves the attestation for the caller's own finish.
 */
async function runRegistration(
	bid: string,
	request: { headers: Record<string, string>; body: Record<string, string> },
	beginError: (begin: Response) => Error,
	ceremonyFailed: () => Error
): Promise<unknown> {
	const ctl = startCeremony();
	const begin = await fetch('/api/passkey/register/begin', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...request.headers },
		body: JSON.stringify({ browser_id: bid, ...request.body }),
		signal: ctl.signal
	});
	if (!begin.ok) throw beginError(begin);
	const opts = await begin.json();
	try {
		return await (await loadWebauthn()).startRegistration({ optionsJSON: opts.publicKey });
	} catch (e) {
		throw classifyCeremonyError(e) ?? ceremonyFailed();
	}
}

/**
 * The link a new account comes in by on an invite-only instance
 * (SHOPPINGLIST_SIGNUP=invite, [D-241]): a list's invite token, which also
 * puts the account on that list, or the setup token from the server's log.
 */
export type SignupLink = { invite: string } | { setup: string };

export async function register(nickname: string, link?: SignupLink): Promise<void> {
	// A device keeps its auth RECORD until logout() (§5.8: only the token
	// expires), so a record here means this would mint a SECOND account. The
	// request carries no Authorization header, so the server cannot tell this
	// from a genuine signup: the check can only live here.
	if (pb.authStore.record) throw new LocalizedError(t('auth_already_have_account'));
	const bid = browserId();
	const attResp = await runRegistration(
		bid,
		{ headers: {}, body: { nickname, ...link } },
		// 403 is the signup gate (SHOPPINGLIST_SIGNUP), a standing state not worth
		// retrying; with a link in hand it means the link is no longer valid.
		(begin) =>
			new LocalizedError(
				t(
					begin.status !== 403
						? 'auth_register_begin_failed'
						: link
							? 'auth_register_link_invalid'
							: 'auth_register_closed'
				)
			),
		() => new LocalizedError(t('auth_ceremony_failed'))
	);
	// The link checked at begin can be revoked during the ceremony ([D-241]).
	await finishCeremony('/api/passkey/register/finish', bid, attResp, undefined, (finish) =>
		finish.status === 403 && link ? new LocalizedError(t('auth_register_link_invalid')) : null
	);
}

/**
 * Adds a new passkey to the CURRENTLY authenticated account (§5.4).
 *
 * Deliberately not a mode of register(): registerBegin adds to the caller's
 * account only when the request carries the session's Authorization header
 * (backend/internal/webauthn/handlers.go), and register() never sends it, so
 * reusing it would silently create a second account. Its finish also answers
 * `{ok:true}`, not finishCeremony's `{token,record}`.
 *
 * @param friendlyName User-provided name for this passkey (e.g. "iPhone 15").
 */
export async function addPasskey(friendlyName: string): Promise<void> {
	if (!pb.authStore.isValid || !pb.authStore.token) {
		throw new LocalizedError(t('auth_not_authenticated'));
	}
	const bid = browserId();
	const failed = () => new LocalizedError(t('auth_add_passkey_failed'));
	const attResp = await runRegistration(
		bid,
		{ headers: authHeaders(), body: { friendly_name: friendlyName } },
		(begin) => {
			if (begin.status !== 401) return failed();
			// The token no longer verifies (signed out everywhere): ask for a
			// sign-in instead of a passkey for an account that is not signed in.
			markAuthExpired();
			return new LocalizedError(t('auth_not_authenticated'));
		},
		failed
	);
	// THIS finish must carry the Authorization header: the server re-asserts
	// that e.Auth is the account register/begin opened the session for, and
	// resolves e.Auth from this header alone.
	if (!pb.authStore.isValid || !pb.authStore.token) {
		throw new LocalizedError(t('auth_not_authenticated'));
	}
	const finish = await fetch('/api/passkey/register/finish', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Browser-Id': bid, ...authHeaders() },
		body: JSON.stringify(attResp)
	});
	if (!finish.ok) throw failed();
}

export interface LoginOptions {
	/**
	 * Run the ceremony under conditional mediation: the passkey is offered in
	 * the autofill dropdown of a field marked `autocomplete="… webauthn"`
	 * instead of a modal prompt.
	 *
	 * The promise then stays PENDING until the user picks a credential, and
	 * rejects with an AbortError when another ceremony starts. Treat it as a
	 * background attempt and never surface its rejection (see AuthScreen).
	 */
	conditional?: boolean;
	/**
	 * A re-auth: the account this device is signed into. A passkey for any
	 * other account is refused with WrongAccountError ([D-76]).
	 */
	expectAccount?: string;
}

export async function login({
	conditional = false,
	expectAccount
}: LoginOptions = {}): Promise<void> {
	const bid = browserId();
	const ctl = startCeremony();
	conditionalCeremony = conditional ? ctl : null;
	// One try for the WHOLE ceremony: any fetch can be aborted by the next
	// startCeremony(), and .cause keeps the DOMException for
	// isCeremonyDismissal().
	try {
		const begin = await fetch('/api/passkey/login/begin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ browser_id: bid }),
			signal: ctl.signal
		});
		if (!begin.ok) throw new LocalizedError(t('auth_login_begin_failed'));
		const opts = await begin.json();
		const asnResp = await (
			await loadWebauthn()
		).startAuthentication({
			optionsJSON: opts.publicKey,
			useBrowserAutofill: conditional
		});
		try {
			await finishCeremony('/api/passkey/login/finish', bid, asnResp, expectAccount, (finish) =>
				finish.status === 404 ? new UnknownPasskeyError(t('auth_passkey_unknown')) : null
			);
		} catch (e) {
			if (e instanceof UnknownPasskeyError) {
				forgetPasskey(opts.publicKey?.rpId, (asnResp as { id: string }).id);
			}
			throw e;
		}
	} catch (e) {
		if (e instanceof WrongAccountError || e instanceof UnknownPasskeyError) throw e;
		throw Object.assign(classifyCeremonyError(e) ?? new LocalizedError(t('auth_ceremony_failed')), {
			cause: e
		});
	}
}

/**
 * Whether a login() rejection is the user's own choice not to complete the
 * ceremony: dismissed (NotAllowedError) or superseded (AbortError). Reads the
 * original DOMException off `.cause`. AuthScreen's background conditional
 * attempt rejects this way as its NORMAL path and must stay silent.
 */
export function isCeremonyDismissal(e: unknown): boolean {
	const cause = e instanceof Error ? e.cause : undefined;
	return (
		cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'NotAllowedError')
	);
}

/**
 * Whether a conditional login() was refused by a browser that offered
 * autofill it cannot run: with no passkey provider, Chromium answers
 * `isConditionalMediationAvailable()` with true and then rejects at once
 * with NotSupportedError, before the user did anything.
 */
export function isAutofillUnsupported(e: unknown): boolean {
	const cause = e instanceof Error ? e.cause : undefined;
	return cause instanceof Error && cause.name === 'NotSupportedError';
}
