// The instance's login methods ([D-76]) as settings and the sync banner see
// them, one store so they agree. It starts from the last answer this device saw,
// so settings renders offline. The signed-out auth screen does not use it: it
// fetches fresh, because a stale answer there would offer a dead button.
import { writable, type Readable } from 'svelte/store';
import {
	authState,
	cachedAuthMethods,
	fetchAuthMethods,
	type AuthMethods
} from '#lib/auth/index.js';

const store = writable<AuthMethods | null>(cachedAuthMethods());

export const authMethods: Readable<AuthMethods | null> = store;

// What the OIDC login is linked as belongs to one account: after a sign-out
// the next person on this device must not see it ([D-293]). The cached copy
// carries only what the instance offers.
authState.subscribe(({ nickname }) => {
	if (nickname === null) store.set(cachedAuthMethods());
});

/**
 * Ask the server again; keeps the last answer when it cannot be reached.
 * Resolves whether the store now holds a fresh answer.
 */
export async function refreshAuthMethods(): Promise<boolean> {
	const methods = await fetchAuthMethods();
	if (methods) store.set(methods);
	return methods !== null;
}
