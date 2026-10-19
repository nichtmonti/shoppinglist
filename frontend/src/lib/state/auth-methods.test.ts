// [D-293] What the OIDC login is linked as belongs to one account, so a
// sign-out takes it off the shared store the next person's settings read.
import { get, writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	authState: null as unknown as ReturnType<typeof writable<{ nickname: string | null }>>
}));

vi.mock('#lib/auth/index.js', async () => {
	const { writable } = await import('svelte/store');
	mocks.authState = writable<{ nickname: string | null }>({ nickname: 'Anna' });
	const instance = {
		passkeys: { enabled: true, signup: true },
		oidc: { enabled: true, name: 'Firma' }
	};
	return {
		authState: mocks.authState,
		cachedAuthMethods: () => instance,
		fetchAuthMethods: async () => ({
			...instance,
			oidc: { ...instance.oidc, linked: true, identity: 'anna@example.test' }
		})
	};
});

import { authMethods, refreshAuthMethods } from './auth-methods';

describe('authMethods', () => {
	it("forgets the signed-out account's OIDC link", async () => {
		await refreshAuthMethods();
		expect(get(authMethods)?.oidc).toMatchObject({ linked: true, identity: 'anna@example.test' });

		mocks.authState.set({ nickname: null });

		expect(get(authMethods)?.oidc.linked).toBeUndefined();
		expect(get(authMethods)?.oidc.identity).toBeUndefined();
		expect(get(authMethods)?.oidc.name).toBe('Firma');
	});
});
