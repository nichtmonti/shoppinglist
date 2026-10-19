// PocketBase client + an IndexedDB-backed async auth store (§5.6).
import PocketBase, { AsyncAuthStore } from 'pocketbase';
import { idbDel, idbGet, idbSet } from './idb';
import { announceSessionStart } from './auth/session';

const TOKEN_KEY = 'pb_auth';

// The promise the AsyncAuthStore awaits on boot; the auth layer awaits it too,
// so it does not read isValid before the persisted token is applied.
export const initialToken = idbGet(TOKEN_KEY);

export const authStore = new AsyncAuthStore({
	save: async (token) => {
		if (token) {
			await idbSet(TOKEN_KEY, token);
			// Stored first: another tab that reloads on this reads the account.
			const account = accountOf(token);
			if (account) announceSessionStart(account);
		} else {
			await idbDel(TOKEN_KEY);
		}
	},
	clear: async () => {
		await idbDel(TOKEN_KEY);
	},
	initial: initialToken
});

/** The account id in a stored `{token, record}` blob, or '' for none. */
function accountOf(serialized: string): string {
	try {
		const id = (JSON.parse(serialized) as { record?: { id?: unknown } }).record?.id;
		return typeof id === 'string' ? id : '';
	} catch {
		return '';
	}
}

// DELIBERATELY '/' rather than '': the SDK resolves a baseURL without a leading
// '/' against the current page path, so a call on `/list/<id>` would hit
// `/list/<id>/api/...` and get the SPA fallback's index.html with a 200.
export const pb = new PocketBase('/', authStore);

// The SDK answers a 200 whose body it could not read, short of an abort (a
// navigation or a dropped connection cutting it off), with `{}`: a cut
// response passed for an empty success, and a caller kept it (settings once
// crashed on a cached login-methods answer of `{}`). So a request resolves
// only once its whole body arrived, and a cut one fails like any other.
pb.beforeSend = (url, options) => ({ url, options: { ...options, fetch: wholeBody } });

async function wholeBody(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const response = await fetch(input, init);
	await response.clone().arrayBuffer();
	return response;
}

/**
 * The Authorization header for a hand-made `fetch` to one of the app's own
 * routes: the session's token, or no header when signed out. `token` defaults
 * to this session's; pass another to act as a different account (the OIDC link).
 */
export function authHeaders(token: string = pb.authStore.token): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}
