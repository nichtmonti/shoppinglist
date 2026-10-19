// The account code at the foot of settings ([D-262]): four characters that
// tell two accounts apart when their nicknames match, the same on every
// device signed in to the account. Derived from the account id, so nothing is
// stored and no request asks for it.

// Crockford's base32: no I, L, O or U, so no character reads as another.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The account's code: 20 bits of the id's FNV-1a hash in four base32
 * characters. A label, not a secret: one person's two accounts share one with
 * odds of about one in a million.
 */
export function accountCode(accountId: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < accountId.length; i++) {
		hash ^= accountId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	let bits = hash >>> 12;
	let code = '';
	for (let i = 0; i < 4; i++) {
		code = ALPHABET[bits & 31] + code;
		bits >>>= 5;
	}
	return code;
}
