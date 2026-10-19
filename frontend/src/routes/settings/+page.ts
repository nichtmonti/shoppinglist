// The settings screen's data is read before it renders ([D-205]); see
// routes/list/[id]/+layout.ts. The passkeys come from the server, under the
// same cap: `null` past it, and the group asks again.
import { get } from 'svelte/store';
import { listPasskeys, type PasskeyRow } from '#lib/actions/account.js';
import { initialToken, pb } from '#lib/pb.js';
import { authMethods } from '#lib/state/auth-methods.js';
import { capped, preloadSettings } from '#lib/state/data.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
	// No group to fill on an instance without passkeys ([D-76]).
	const passkeysOn = get(authMethods)?.passkeys.enabled ?? true;
	const [passkeys] = await Promise.all([
		passkeysOn ? capped(signedInPasskeys()) : null,
		preloadSettings()
	]);
	return { passkeys };
};

// A cold start restores the session from IndexedDB, and the server answers a
// list asked for without it with an empty one rather than a refusal. Signed
// out, the group asks once the account is there.
async function signedInPasskeys(): Promise<PasskeyRow[] | null> {
	await initialToken;
	return pb.authStore.isValid ? listPasskeys() : null;
}
