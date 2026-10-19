// The app's auth entry point; every caller imports `#lib/auth/index.js`. It
// registers the listeners that keep `authState` current, re-exports the
// ceremonies beside it (passkey §5.4, OIDC §5.9, login methods), and owns the
// session's start and end on this device: the start-up refresh (§5.6) and
// sign-out with its local teardown.
import { initialToken, pb } from '../pb';
import { wipeLocalAccountData } from './account-data';
import { isAuthRejected, markAuthExpired, refreshSessionToken, syncAuthState } from './state';
import { PHOTO_CACHE } from '../photo-cache';
import { endSession, onRemoteSessionEnd, onRemoteSessionStart, sessionScope } from './session';

export { authState, syncAuthState } from './state';
export {
	addPasskey,
	canUsePasskeyAutofill,
	canUsePasskeys,
	cancelConditionalLogin,
	isAutofillUnsupported,
	isCeremonyDismissal,
	login,
	register,
	type LoginOptions,
	type SignupLink
} from './passkey';
export { clearSetupToken, setupToken } from './setup-link';
export { cancelOidcLogin, linkOidc, oidcLogin, unlinkOidc } from './oidc';
export { WrongAccountError } from './wrong-account';
export {
	cachedAuthMethods,
	fetchAuthMethods,
	lastLoginMethod,
	type AuthMethods,
	type LoginMethod,
	type OidcStatus
} from './login-methods';

// Every save() and clear() of the token publishes it, synchronously.
pb.authStore.onChange(syncAuthState);

// A sign-out in ANOTHER tab ends the account here too (§5.6 [D-109]). Each
// tab holds its token in memory, so the other tab clearing storage does not
// sign this one out; without this it would keep re-populating the tables that
// tab wiped. The clear is local (broadcasting lives in logout()), so it does
// not echo back.
onRemoteSessionEnd(() => pb.authStore.clear());

// A sign-in in ANOTHER tab to another account, or while this one is signed
// out: the tabs share the stored token and the local mirror, so two accounts
// side by side would mix ([D-109]). This tab reloads, which reads the new
// account's stored token. A token refresh announces the same account and
// changes nothing.
onRemoteSessionStart((accountId) => {
	if (pb.authStore.record?.id === accountId) return;
	location.reload();
});

/**
 * End the session on THIS device (§5.6 [D-55]) and take the account's local
 * data with it. Callers that report "signed out" must await it: it resolves
 * when the Dexie wipe is done. The store is cleared before the wipe, so every
 * later request goes out unauthenticated.
 */
export async function logout(): Promise<void> {
	// FIRST: disown everything in flight (§5.6 [D-109]) so none of it can write
	// behind the wipe below.
	endSession();
	pb.authStore.clear();
	// The SW photo cache is origin-wide, so it would show the next person which
	// products this account scanned ([D-21]). Fire-and-forget: photos are
	// re-fetchable. `caches` is absent in SSR/tests.
	if (typeof caches !== 'undefined') void caches.delete(PHOTO_CACHE);
	// Awaited: this is what sign-out is for (./account-data says what stays).
	await wipeLocalAccountData();
}

// On app load: wait for the async store to apply its persisted token (its
// initial load awaited the same promise first, so the token is in), then
// refresh it (§5.6). A sign-out during the refresh wins.
export async function refreshOnStart(): Promise<void> {
	await initialToken;
	if (pb.authStore.isValid) {
		const session = sessionScope();
		try {
			await refreshSessionToken();
		} catch (error) {
			if (!session.owned()) return;
			// A network failure keeps the unexpired session usable offline. A 401
			// means the token is dead: gate sync now, but keep the record and
			// Dexie data for §5.8's one-tap re-auth.
			if (isAuthRejected(error)) {
				markAuthExpired();
				return;
			}
		}
	}
	syncAuthState();
}
