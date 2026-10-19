// Shared item-name normalization (§9, [D-44]), the TypeScript half: trim →
// NFKC → lowercase → collapse whitespace runs → trim. Umlauts and ß are
// deliberately not folded.
//
// This MUST agree with backend/internal/normalize/normalize.go for every input,
// since the server merges duplicate creates on it (§8.3 [D-29]); both suites
// pin it against seed/normalization-vectors.json. The helpers below exist
// because JS's `trim()`, `/\s+/` and `toLowerCase()` each disagree with Go.

// Go's strings.TrimSpace trims unicode.IsSpace, which is NOT the set
// String.prototype.trim() uses: trim() strips U+FEFF (Go keeps it) and keeps
// U+0085 NEL (Go strips it). This class is exactly Unicode White_Space.
const GO_SPACE =
	'\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TRIM_RE = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'g');

// Go's regexp `\s` is the ASCII class [\t\n\f\r ], narrower than JavaScript's
// (which adds VT, U+2028 and U+FEFF among others); NFKC has already folded the
// compatibility spaces to U+0020.
const COLLAPSE_RE = /[\t\n\f\r ]+/g;

// Go's strings.ToLower is Unicode's simple per-rune mapping; JavaScript's
// toLowerCase() is the full, context-sensitive one (final Σ → ς, İ → i + U+0307).
// Lowercasing per code point removes the context; U+0130 is the one
// unconditional special case left, so it is mapped explicitly.
function simpleLower(s: string): string {
	let out = '';
	for (const ch of s) {
		out += ch === 'İ' ? 'i' : ch.toLowerCase();
	}
	return out;
}

/** The canonical form of an item name. */
export function normalizeName(s: string): string {
	const trimmed = s.replace(TRIM_RE, '');
	const folded = simpleLower(trimmed.normalize('NFKC'));
	return folded.replace(COLLAPSE_RE, ' ').replace(TRIM_RE, '');
}
