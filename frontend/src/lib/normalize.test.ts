import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { normalizeName } from './normalize';

interface Vector {
	in: string;
	out: string;
	note: string;
}

// The SAME file the Go suite reads (backend/internal/normalize/normalize_test.go).
// [D-44] makes this fixture the enforcement mechanism for cross-language
// agreement, so it must be one file, not two copies.
const vectors = JSON.parse(
	readFileSync(
		new URL('../../../backend/seed/normalization-vectors.json', import.meta.url),
		'utf-8'
	)
) as Vector[];

describe('normalizeName — shared [D-44] vectors', () => {
	it('has vectors to check', () => {
		expect(vectors.length).toBeGreaterThan(0);
	});

	for (const v of vectors) {
		it(`${JSON.stringify(v.in)} → ${JSON.stringify(v.out)} (${v.note})`, () => {
			expect(normalizeName(v.in)).toBe(v.out);
		});
	}
});

describe('normalizeName — properties the vectors imply', () => {
	it('is idempotent over every vector', () => {
		for (const v of vectors) {
			expect(normalizeName(v.out)).toBe(v.out);
		}
	});

	it('keeps deliberately-excluded folds distinct', () => {
		// The asymmetric-cost rule of §9: a false positive silently collapses two
		// rows the user meant to keep apart, which is worse than a visible duplicate.
		expect(normalizeName('Müsli')).not.toBe(normalizeName('Muesli'));
		expect(normalizeName('Bußgeld')).not.toBe(normalizeName('Bussgeld'));
	});
});
