// The one `#lib/auth/index.js` mock for component tests ([D-77]).
//
// A `vi.mock('#lib/auth/index.js')` block that hand-declares its export list breaks
// whenever `#lib/auth/index.js` gains an export its rendered component imports — and
// only in the tests that render that component. This factory is the one
// export list; `auth-mock.test.ts` pins it to the real module's runtime
// exports, so a new export fails a test that names the remedy instead of a
// stranger's test file.
//
// Usage inside a hoisted vi.mock factory (the factory import must be dynamic
// — hoisting puts it above the test file's own imports):
//
//	vi.mock('#lib/auth/index.js', async () => {
//		const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
//		return authModuleMock({ login: vi.fn() }, { isValid: true });
//	});
//
// The returned vi.fn()s are created once per test FILE (vi.mock factories run
// once per module registry), so per-test `vi.mocked(x).mockReturnValue(...)`
// overrides in beforeEach keep working unchanged.
import { vi } from 'vitest';
import { writable, type Writable } from 'svelte/store';
import type { AuthState } from '#lib/auth/state.js';
import { WrongAccountError } from '#lib/auth/wrong-account.js';

export interface AuthStateOptions {
	nickname?: string | null;
	isValid?: boolean;
}

export type AuthModuleMock = Record<string, unknown> & {
	authState: Writable<AuthState>;
};

/** The classic instance's answer: passkeys on and open, no OIDC. */
export function defaultAuthMethods(
	overrides: {
		passkeys?: Partial<{ enabled: boolean; signup: boolean; signup_by_link: boolean }>;
		oidc?: Record<string, unknown>;
	} = {}
) {
	return {
		passkeys: { enabled: true, signup: true, signup_by_link: true, ...overrides.passkeys },
		oidc: { enabled: false, ...overrides.oidc }
	};
}

export function authModuleMock(
	overrides: Record<string, unknown> = {},
	authState: AuthStateOptions = {}
): AuthModuleMock {
	return {
		authState: writable<AuthState>({
			nickname: authState.nickname ?? null,
			isValid: authState.isValid ?? false
		}),
		canUsePasskeys: vi.fn(() => true),
		canUsePasskeyAutofill: vi.fn(async () => true),
		register: vi.fn(),
		// [D-241] No setup link unless a test opens the page with one.
		setupToken: vi.fn(() => null),
		clearSetupToken: vi.fn(),
		login: vi.fn(),
		logout: vi.fn(),
		addPasskey: vi.fn(),
		syncAuthState: vi.fn(),
		refreshOnStart: vi.fn(async () => {}),
		// [D-76]: the probe defaults to the classic instance — passkeys on and
		// open, no OIDC — so tests see that screen unless they say otherwise.
		fetchAuthMethods: vi.fn(async () => defaultAuthMethods()),
		cachedAuthMethods: vi.fn(() => null),
		oidcLogin: vi.fn(async () => true),
		lastLoginMethod: vi.fn(() => null),
		cancelOidcLogin: vi.fn(),
		linkOidc: vi.fn(async () => true),
		unlinkOidc: vi.fn(async () => {}),
		WrongAccountError,
		// Mirrors the real predicate's semantics simplified for mocks: mocked
		// ceremony functions reject with raw Errors, so name-based is enough.
		isCeremonyDismissal: vi.fn(
			(e: unknown) =>
				e instanceof Error && (e.name === 'AbortError' || e.name === 'NotAllowedError')
		),
		isAutofillUnsupported: vi.fn(
			(e: unknown) => e instanceof Error && e.name === 'NotSupportedError'
		),
		...overrides
	};
}
