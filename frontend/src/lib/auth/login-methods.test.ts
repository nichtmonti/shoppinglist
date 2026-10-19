// [D-76] [D-241] the one reading of the instance's login methods.
import { describe, expect, it } from 'vitest';
import { oidcProvider, passkeySignup, type AuthMethods } from './login-methods';

function methods(
	passkeys: Partial<AuthMethods['passkeys']> = {},
	oidc: AuthMethods['oidc'] = { enabled: false }
): AuthMethods {
	return { passkeys: { enabled: true, signup: true, ...passkeys }, oidc };
}

describe('oidcProvider', () => {
	it('names the provider only while the instance has OIDC on', () => {
		expect(oidcProvider(methods({}, { enabled: true, provider: 'oidc' }))).toBe('oidc');
		expect(oidcProvider(methods({}, { enabled: false, provider: 'oidc' }))).toBeUndefined();
		expect(oidcProvider(methods({}, { enabled: true }))).toBeUndefined();
	});
});

describe('passkeySignup', () => {
	it('is open to anyone on an open instance', () => {
		expect(passkeySignup(methods(), false)).toBe('open');
	});

	it('is open to a link holder on an invite-only one, and asks the others for a link', () => {
		const inviteOnly = methods({ signup: false, signup_by_link: true });
		expect(passkeySignup(inviteOnly, true)).toBe('open');
		expect(passkeySignup(inviteOnly, false)).toBe('link');
	});

	it('is closed with signup off, or passkeys off, or an older answer without links', () => {
		expect(passkeySignup(methods({ signup: false, signup_by_link: false }), true)).toBe('closed');
		expect(passkeySignup(methods({ signup: false }), true)).toBe('closed');
		expect(passkeySignup(methods({ enabled: false, signup_by_link: true }), true)).toBe('closed');
	});
});
