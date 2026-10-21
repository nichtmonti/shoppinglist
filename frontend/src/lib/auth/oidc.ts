// OIDC sign-in, attaching an OIDC login to the account (§5.9, [D-76]) and
// its removal ([D-76]).
import PocketBase, {
	BaseAuthStore,
	ClientResponseError,
	type RecordAuthResponse
} from 'pocketbase';
import { authHeaders, pb } from '../pb';
import { rememberLoginMethod } from './login-methods';
import { WrongAccountError } from './wrong-account';
import { t } from '../i18n';
import { LocalizedError } from '../localized-error';
import { httpStatus } from '../http-status';

// The SDK's realtime OAuth2 form needs this page's live @oauth2 subscription
// to receive {state, code}, so the provider opens in a POPUP rather than by
// navigating away ([D-76]).
const OIDC_REQUEST_KEY = 'shoppinglist-oidc';

/**
 * Start the OIDC sign-in flow for `provider` and settle the session into the
 * auth store. Resolves `true` once signed in, `false` when cancelled
 * (`cancelOidcLogin`).
 *
 * The SDK opens the popup itself, before its first await, as Safari requires
 * of window.open, and closes it when the attempt ends; so this must be called
 * on the click, with no await before it.
 *
 * Nothing watches the popup: COOP severs the opener's handle once it reaches
 * the provider, so `popup.closed` reads true mid-sign-in and a poll would
 * cancel every login ([D-155]). An attempt ends by completing or by
 * `cancelOidcLogin`.
 */
export async function oidcLogin(
	provider: string,
	{ expectAccount }: OidcLoginOptions = {}
): Promise<boolean> {
	if (expectAccount) return oidcReauth(provider, expectAccount);
	if ((await oidcExchange(pb, provider)) === null) return false;
	rememberLoginMethod('oidc');
	return true;
}

export interface OidcLoginOptions {
	/**
	 * A re-auth: the account this device is signed into. A sign-in that lands
	 * in any other account is refused with WrongAccountError ([D-76]).
	 */
	expectAccount?: string;
}

/**
 * The re-auth form of oidcLogin ([D-76]): the exchange runs on a throwaway
 * client, and its session reaches the app's store only once it is the account
 * this device was signed into. Saved first and checked after, a sync cycle in
 * between would run as the other account over this one's local data (see
 * linkOidc).
 *
 * The other account is usually one the exchange just created (the OIDC login
 * was removed from this account). It is deleted again with its own token and
 * the device remembers the passkey instead. An EXISTING other account is left
 * alone.
 */
async function oidcReauth(provider: string, expectAccount: string): Promise<boolean> {
	const client = new PocketBase(pb.baseURL, new BaseAuthStore());
	pendingClient = client;
	try {
		const auth = await oidcExchange(client, provider);
		if (auth === null) return false;
		if (client.authStore.record?.id !== expectAccount) {
			const orphan = auth?.meta?.isNew === true;
			if (orphan) {
				// Best effort: the §13 orphan sweep takes an account with no
				// lists if this does not get through.
				await client.send('/api/account/delete', { method: 'POST' }).catch(() => undefined);
				rememberLoginMethod('passkey');
			}
			throw new WrongAccountError(orphan);
		}
	} finally {
		if (pendingClient === client) pendingClient = null;
	}
	pb.authStore.save(client.authStore.token, client.authStore.record);
	rememberLoginMethod('oidc');
	return true;
}

// The popup flow on `client`: the app's `pb` for a sign-in, a throwaway client
// for a link or a re-auth. Resolves the exchange's response, or `null` when
// cancelled.
async function oidcExchange(
	client: PocketBase,
	provider: string
): Promise<RecordAuthResponse | null> {
	try {
		return await client.collection('accounts').authWithOAuth2({
			provider,
			requestKey: OIDC_REQUEST_KEY
		});
	} catch (e) {
		if (e instanceof ClientResponseError && e.isAbort) return null;
		// The messages below name no cause; this is where it can be read.
		console.warn('[oidc] sign-in failed:', e);
		// The server refused AFTER the provider accepted the user: the instance's
		// OIDC setup is at fault, and the server log names the cause ([D-209]).
		if (e instanceof ClientResponseError && e.status >= 400 && e.url.includes('auth-with-oauth2')) {
			throw new LocalizedError(t('auth_oidc_server_failed'), { cause: e });
		}
		throw new LocalizedError(t('auth_oidc_failed'), { cause: e });
	}
}

// The client a pending link's or re-auth's popup exchange runs on, so
// cancelOidcLogin reaches it.
let pendingClient: PocketBase | null = null;

/**
 * Give up on a pending `oidcLogin` or `linkOidc` (the user closed the popup or
 * changed their mind). Aborts the attempt's request key; the pending call
 * resolves `false`.
 */
export function cancelOidcLogin(): void {
	pb.cancelRequest(OIDC_REQUEST_KEY);
	pendingClient?.cancelRequest(OIDC_REQUEST_KEY);
}

/**
 * The §5.9 [D-76] link: attach the OIDC login the popup flow signs in with to
 * the CURRENTLY signed-in account. Resolves `true` once attached, `false` when
 * cancelled (nothing changed). The device keeps its session throughout.
 *
 * The provider sign-in lands in an account, usually a new empty one; its token
 * is only the proof. The server attaches when both tokens verify and deletes
 * the empty account; one with lists or passkeys of its own is refused (409,
 * `settings_link_oidc_in_use`).
 *
 * The exchange runs on its own in-memory client so the app's store never holds
 * the OIDC account's session: a sync cycle in between (the popup closing
 * refocuses this window) would run as that account, revert every queued edit
 * as `not_member` and purge every local list. It also sends no session bearer,
 * which PocketBase would read as a claim to attach the subject to that account
 * ([D-76], backend/internal/oidc/hooks.go).
 */
export async function linkOidc(provider: string): Promise<boolean> {
	const sessionToken = pb.authStore.token;
	if (!pb.authStore.isValid || !sessionToken) {
		throw new LocalizedError(t('auth_not_authenticated'));
	}
	const client = new PocketBase(pb.baseURL, new BaseAuthStore());
	pendingClient = client;
	try {
		if ((await oidcExchange(client, provider)) === null) return false;
		// The session's token, as it was when the link began: the popup's
		// sign-in went into the throwaway client.
		await pb
			.send('/api/account/link', {
				method: 'POST',
				headers: authHeaders(sessionToken),
				body: { token: client.authStore.token }
			})
			.catch((e: unknown) => {
				throw new LocalizedError(
					t(httpStatus(e) === 409 ? 'settings_link_oidc_in_use' : 'settings_link_oidc_failed')
				);
			});
	} finally {
		if (pendingClient === client) pendingClient = null;
		client.authStore.clear();
	}
	rememberLoginMethod('oidc');
	return true;
}

/**
 * Remove this account's OIDC login ([D-76]). The server refuses (409) while
 * it is the account's only way in. The device then remembers the passkey, so
 * a re-auth does not open the provider, whose sign-in would now create a
 * separate account.
 */
export async function unlinkOidc(): Promise<void> {
	try {
		await pb.send('/api/account/unlink', { method: 'POST' });
	} catch (e) {
		const needsPasskey = e instanceof ClientResponseError && e.status === 409;
		throw new LocalizedError(
			t(needsPasskey ? 'settings_unlink_oidc_needs_passkey' : 'settings_unlink_oidc_failed'),
			{
				cause: e
			}
		);
	}
	rememberLoginMethod('passkey');
}
