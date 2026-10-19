// One-tap §5.8 re-auth, shared by the sync chip and the home's expired state
// ([D-130], [D-76], [D-182]). Failures go to the toaster, since neither caller
// has room for an error; a dismissal (which includes AbortError from a
// superseded ceremony) is silent, and `busy` stops a double tap starting one.
import { get } from 'svelte/store';
import {
	canUsePasskeys,
	cancelOidcLogin,
	isCeremonyDismissal,
	lastLoginMethod,
	login,
	logout,
	oidcLogin,
	WrongAccountError,
	type LoginMethod
} from '#lib/auth/index.js';
import { oidcProvider } from '#lib/auth/login-methods.js';
import { pb } from '#lib/pb.js';
import { demo } from '#demo';
import { authMethods } from '#lib/state/auth-methods.js';
import { showFailure } from '#lib/toasts.js';
import { failureMessage } from './async-action.svelte.js';
import { t } from '#lib/i18n/index.js';

/**
 * [D-76]: the login this device last signed in with, while the instance still
 * has it on, else whichever it has; an expired session cannot ask the server.
 * With no answer from the instance yet, passkeys are assumed.
 */
function reauthMethod(): LoginMethod | null {
	const methods = get(authMethods);
	const passkey = (methods?.passkeys.enabled ?? true) && canUsePasskeys();
	const oidc = !!(methods && oidcProvider(methods));
	const last = lastLoginMethod();
	if (last === 'oidc' && oidc) return 'oidc';
	if (last === 'passkey' && passkey) return 'passkey';
	if (passkey) return 'passkey';
	return oidc ? 'oidc' : null;
}

export class Reauth {
	busy = $state(false);
	/** An OIDC popup is open: a tap now cancels it instead of starting another. */
	pendingOidc = $state(false);

	async run(): Promise<void> {
		// A second tap while the provider popup is open gives up on it: the page
		// cannot tell whether the popup is still there (see oidcLogin).
		if (this.pendingOidc) {
			cancelOidcLogin();
			return;
		}
		if (this.busy) return;
		const method = reauthMethod();
		if (!method) {
			// [D-234] A demo account has no login to renew: the server deleted
			// it, so the tap starts over, as the demo banner's button does.
			if (demo.enabled) await logout();
			return;
		}
		// [D-76]: re-auth must land in the account this device holds. An
		// expired session keeps its record, so the id is still here.
		const expectAccount = pb.authStore.record?.id;
		this.busy = true;
		try {
			if (method === 'oidc') {
				this.pendingOidc = true;
				// Called synchronously in the tap: oidcLogin opens its popup as its
				// first statement, which needs this user activation.
				await oidcLogin(get(authMethods)?.oidc.provider ?? '', { expectAccount });
			} else {
				await login({ expectAccount });
			}
		} catch (e) {
			if (e instanceof WrongAccountError) {
				showFailure(wrongAccountMessage(e));
			} else if (!isCeremonyDismissal(e)) {
				showFailure(failureMessage(e));
			}
		} finally {
			this.busy = false;
			this.pendingOidc = false;
		}
	}
}

// An orphan means the OIDC login was removed from this account ([D-76]), and
// the button now offers the passkey. Otherwise it was another account's login.
function wrongAccountMessage(e: WrongAccountError): string {
	if (!e.orphan) return t('reauth_wrong_account');
	return t('reauth_oidc_not_linked', { name: get(authMethods)?.oidc.name ?? '' });
}
