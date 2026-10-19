import { describe, expect, it } from 'vitest';

import { accountCode } from './account-code';

describe('accountCode ([D-262])', () => {
	it('is four Crockford base32 characters', () => {
		for (const id of ['', 'a', 'k3m9x2p7q4w8z1r', 'zzzzzzzzzzzzzzz']) {
			expect(accountCode(id)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
		}
	});

	// Every device derives it on its own, so it must not change between
	// releases: a changed code would read as a different account.
	it('is fixed for an id', () => {
		expect(accountCode('k3m9x2p7q4w8z1r')).toMatchInlineSnapshot(`"6KNS"`);
	});

	it('tells ids that differ in one character apart', () => {
		expect(accountCode('k3m9x2p7q4w8z1r')).not.toBe(accountCode('k3m9x2p7q4w8z1s'));
	});
});
