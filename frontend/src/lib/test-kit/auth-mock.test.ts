// The other half of [D-77]: this test FAILS when `#lib/auth/index.js` grows an export
// the shared mock factory does not cover — a gap that would otherwise surface
// as unhandled errors in an unrelated component test. When this fires: add
// the export to `authModuleMock` in auth-mock.ts. That is the whole remedy.
//
// Importing the real `#lib/auth/index.js` needs the same import-time mocks
// auth.test.ts maintains (IndexedDB-backed store, Dexie, WebAuthn bindings);
// the factory, by contrast, is the thing that must NOT need them.
import { describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted(() => ({
	isValid: false,
	token: '',
	record: null,
	onChange: vi.fn(),
	save: vi.fn(),
	clear: vi.fn()
}));

vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({ authStore })
);

vi.mock('#lib/i18n/index.js', () => ({
	t: (key: string) => key
}));

vi.mock('#lib/auth/account-data.js', () => ({
	wipeLocalAccountData: vi.fn(async () => {})
}));

vi.mock('@simplewebauthn/browser', () => ({
	browserSupportsWebAuthn: vi.fn(() => true),
	browserSupportsWebAuthnAutofill: vi.fn(async () => true),
	startRegistration: vi.fn(),
	startAuthentication: vi.fn()
}));

import * as realAuth from '#lib/auth/index.js';
import { authModuleMock } from './auth-mock';

describe('authModuleMock covers the real module', () => {
	it('defines every runtime export of #lib/auth', () => {
		const mock = authModuleMock();
		const missing = Object.keys(realAuth).filter((key) => !(key in mock));
		expect(missing).toEqual([]);
	});
});
