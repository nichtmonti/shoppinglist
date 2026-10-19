// Which logins this instance offers (§5.9, [D-76]), and which one this
// device last used.
import { pb } from '../pb';
import { readStored, writeStored } from '../safe-storage';

// ---- which login this device last used ([D-76]) ----
//
// The sync banner's one-tap re-auth has room for one button and an expired
// session cannot ask which logins the account has, so the device remembers its
// last one. Without storage the banner falls back to the instance's default.

export type LoginMethod = 'passkey' | 'oidc';
const LAST_LOGIN_KEY = 'einkaufsliste-last-login';

export function rememberLoginMethod(method: LoginMethod): void {
	writeStored(LAST_LOGIN_KEY, method);
}

/** How this device last signed in, if it remembers. */
export function lastLoginMethod(): LoginMethod | null {
	const v = readStored(LAST_LOGIN_KEY);
	return v === 'passkey' || v === 'oidc' ? v : null;
}

// ---- the instance's login methods ----

export interface OidcStatus {
	enabled: boolean;
	/** The provider string the SDK's authWithOAuth2({ provider }) takes. */
	provider?: string;
	/** Display label for the button ("Weiter mit ‹name›"). */
	name?: string;
	/** Signed in only: this account already has the OIDC login ([D-25]). */
	linked?: boolean;
	/**
	 * Signed in and linked only: what that login is connected as — the
	 * provider's username, else its address ([D-76]). Absent when the
	 * provider sent neither.
	 */
	identity?: string;
}

/**
 * Which logins this instance offers (SHOPPINGLIST_PASSKEYS, SHOPPINGLIST_OIDC,
 * SHOPPINGLIST_SIGNUP), from GET /api/auth/methods. `passkeys.signup` is
 * passkey signup only: a first OIDC sign-in creates the account regardless.
 * `signup_by_link`: a visitor holding an invite or setup link may sign up
 * ([D-241]); absent from an older server's (or cached) answer.
 */
export interface AuthMethods {
	passkeys: { enabled: boolean; signup: boolean; signup_by_link?: boolean };
	oidc: OidcStatus;
}

/** The provider an OIDC sign-in names, when the instance has that login on ([D-76]). */
export function oidcProvider(methods: AuthMethods): string | undefined {
	return methods.oidc.enabled ? methods.oidc.provider : undefined;
}

/**
 * Whether a visitor may create an account with a passkey here: `open` to
 * anyone, or to one holding an invite or setup link (`withLink`); `link` when
 * the instance is invite-only and no link is in hand ([D-241]). Whether this
 * device can make a passkey is the caller's to add.
 */
export function passkeySignup(methods: AuthMethods, withLink: boolean): 'open' | 'link' | 'closed' {
	const { enabled, signup, signup_by_link } = methods.passkeys;
	if (!enabled) return 'closed';
	if (signup || (signup_by_link && withLink)) return 'open';
	return signup_by_link ? 'link' : 'closed';
}

const METHODS_KEY = 'einkaufsliste-auth-methods';

/**
 * The auth screen's and settings' probe, sent through the SDK so the session
 * token fills `oidc.linked`. Resolves `null` when the server cannot be asked;
 * callers retry or fall back to `cachedAuthMethods()`. The cached copy drops
 * `linked` and `identity`, which are one account's, not the instance's.
 */
export async function fetchAuthMethods(): Promise<AuthMethods | null> {
	try {
		// requestKey null: the SDK would cancel the first of two identical
		// concurrent requests (auth screen and settings).
		const methods = await pb.send<AuthMethods>('/api/auth/methods', { requestKey: null });
		const oidc: OidcStatus = { ...methods.oidc };
		delete oidc.linked;
		delete oidc.identity;
		writeStored(METHODS_KEY, JSON.stringify({ ...methods, oidc }));
		return methods;
	} catch {
		return null;
	}
}

/** The last answer `fetchAuthMethods` saw on this device, if any. */
export function cachedAuthMethods(): AuthMethods | null {
	const raw = readStored(METHODS_KEY);
	if (!raw) return null;
	try {
		// A copy cut short before pb.ts read whole bodies is `{"oidc":{}}`.
		const methods = JSON.parse(raw) as Partial<AuthMethods> | null;
		return methods?.passkeys && methods.oidc ? (methods as AuthMethods) : null;
	} catch {
		return null;
	}
}
