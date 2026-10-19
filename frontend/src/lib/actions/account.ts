// Account-lifecycle mutations for the settings screen (§4.5, §5.4, §5.6, §11):
// online-only, direct PB or custom-route calls, never the outbox.
import { db } from '#lib/db.js';
import {
	canUsePasskeys,
	isCeremonyDismissal,
	login,
	logout,
	oidcLogin,
	WrongAccountError,
	type AuthMethods
} from '#lib/auth/index.js';
import { oidcProvider } from '#lib/auth/login-methods.js';
import { currentAccountId } from '#lib/auth/state.js';
import { pb } from '#lib/pb.js';
import { t } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';
import { refreshRoster } from '#lib/sync/index.js';
import { httpStatus } from '#lib/http-status.js';

// ---- nickname (§11 own-row allowlist) ----------------------------------

/** Direct own-row update — `nickname` is the one self-editable accounts field. */
export async function updateNickname(nickname: string): Promise<void> {
	const id = currentAccountId();
	if (!id) throw new Error('not authenticated');
	await pb.collection('accounts').update(id, { nickname });
}

// ---- passkeys (§5.4) ----------------------------------------------------

export interface PasskeyRow {
	id: string;
	friendly_name: string;
	last_used_at: string | null;
}

/** Own credentials only (§11: `credentials` list/view rule is own-row). */
export async function listPasskeys(): Promise<PasskeyRow[]> {
	const rows = await pb.collection('credentials').getFullList();
	return rows.map((r) => ({
		id: r.id,
		friendly_name: (r.friendly_name as string | undefined) || '',
		last_used_at: (r.last_used_at as string | undefined) || null
	}));
}

/**
 * The server refuses deleting the last credential of an account without OIDC
 * (§5.4, [D-32]); surface its message rather than predicting the guard here.
 */
export async function removePasskey(id: string): Promise<void> {
	try {
		await pb.collection('credentials').delete(id);
	} catch (e) {
		// The server keeps the last login of an account (§5.4); its refusal
		// is English, the reason is this one ([D-293]).
		if (httpStatus(e) === 403) {
			throw new LocalizedError(t('settings_passkey_only_login'));
		}
		throw e;
	}
}

/**
 * Rename a passkey via the dedicated route (§5.4): `credentials` has no
 * UpdateRule (it closed a reparenting takeover), so a direct update is refused.
 */
export async function renamePasskey(id: string, friendlyName: string): Promise<void> {
	await pb.send(`/api/credentials/${id}/rename`, {
		method: 'POST',
		body: { friendly_name: friendlyName }
	});
}

// ---- "log out everywhere" (§5.6) ----------------------------------------

/**
 * §5.6 `POST /api/account/rotate-token-key`: every device's token stops
 * verifying. The local `logout()` must not run if the request failed, or the
 * user would believe a lost phone signed out when it was not.
 */
export async function logoutEverywhere(): Promise<void> {
	await pb.send('/api/account/rotate-token-key', { method: 'POST' });
	await logout();
}

// ---- account deletion (§4.5) --------------------------------------------

export interface DeletionImpact {
	shared: number;
	solo: number;
}

/**
 * Counts this account's lists as shared vs. solo (roster, §7.4, of at most this
 * account) for the delete-account confirmation. The rosters are refreshed
 * first, since a stale one would call a shared list deleted before an
 * irreversible delete; a list whose refresh fails is counted from its cache.
 */
export async function deletionImpact(
	refresh: (listId: string) => Promise<unknown> = refreshRoster
): Promise<DeletionImpact> {
	const memberships = await db.memberships.toArray();
	await Promise.allSettled(memberships.map((m) => refresh(m.list)));
	let shared = 0;
	let solo = 0;
	for (const m of memberships) {
		const count = await db.roster.where('list').equals(m.list).count();
		if (count > 1) shared++;
		else solo++;
	}
	return { shared, solo };
}

/**
 * The sign-in a delete asks for first ([D-309]): the account's passkey where
 * this device can use one, else its OIDC login, by the provider's name; null
 * for an account with neither (a demo account), whose token is enough.
 */
export type DeleteSignIn = 'passkey' | { oidc: string } | null;

/** Which sign-in the delete will ask for, read before its confirmation opens. */
export async function deleteSignIn(methods: AuthMethods | null): Promise<DeleteSignIn> {
	// Unlisted counts as having one: the prompt then says whether it does.
	const hasPasskey = () =>
		listPasskeys().then(
			(rows) => rows.length > 0,
			() => true
		);
	if ((methods?.passkeys.enabled ?? true) && canUsePasskeys() && (await hasPasskey())) {
		return 'passkey';
	}
	const provider = methods?.oidc.linked ? oidcProvider(methods) : undefined;
	return provider ? { oidc: provider } : null;
}

/**
 * §4.5 `POST /api/account/delete`: leave every list, then delete, server-side
 * (never PB's relation cascade). Signs in first, as the server asks ([D-309]),
 * and stops if that is cancelled. Ends the local session on success.
 *
 * Call it in the tap: the OIDC sign-in opens its popup before its first await.
 */
export async function deleteAccountForever(signIn: DeleteSignIn = null): Promise<void> {
	const expectAccount = currentAccountId() ?? undefined;
	const notSignedIn = () => new LocalizedError(t('settings_delete_account_not_signed_in'));
	try {
		if (signIn === 'passkey') await login({ expectAccount });
		else if (signIn && !(await oidcLogin(signIn.oidc, { expectAccount }))) throw notSignedIn();
	} catch (e) {
		if (isCeremonyDismissal(e)) throw notSignedIn();
		if (e instanceof WrongAccountError) throw new LocalizedError(t('reauth_wrong_account'));
		throw e;
	}
	await pb.send('/api/account/delete', { method: 'POST' });
	await logout();
}
