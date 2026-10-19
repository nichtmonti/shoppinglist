// `relativeDays` — the wording half of §6.10's history date ([D-18]). The
// counting half is `#lib/sorting.js`'s daysAgo; this only turns a whole
// number of calendar days into a phrase, which is why it takes a COUNT rather
// than a timestamp (sorting.ts already imports this module, so the reverse
// would close an import cycle).
//
// Worth its own file because the unit ladder is the part a reader will doubt:
// day granularity is the whole point of [D-18] — an elapsed-duration formatter
// reporting minutes about a restocking question is what produced "Zuletzt: vor
// 3 Minuten" and, in turn, [D-18]'s grace window to hide it — but a screen that
// keeps history indefinitely still has to say something sensible about a
// purchase from last year.
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, relativeDays, setLocale } from './index';

const original = getLocale();
afterEach(() => setLocale(original));

describe('relativeDays', () => {
	it('words the near days the way a person would, in German', () => {
		setLocale('de');
		// numeric:'auto' is what buys these: "vor 0/1/2 Tagen" would be correct
		// and wrong at the same time.
		expect(relativeDays(0)).toBe('heute');
		expect(relativeDays(1)).toBe('gestern');
		expect(relativeDays(2)).toBe('vorgestern');
		expect(relativeDays(6)).toBe('vor 6 Tagen');
	});

	it('words the near days in English', () => {
		setLocale('en');
		expect(relativeDays(0)).toBe('today');
		expect(relativeDays(1)).toBe('yesterday');
		expect(relativeDays(9)).toBe('9 days ago');
	});

	it('renders 0 as "today", not as a future or a signed zero', () => {
		// The implementation formats -days, so 0 becomes -0. Intl treats that as
		// 0, but the assertion is cheap and the alternative ("in 0 Tagen" on the
		// screen) would be absurd.
		setLocale('de');
		expect(relativeDays(-0)).toBe('heute');
		expect(relativeDays(0)).not.toContain('in ');
	});

	it('coarsens past a fortnight so the long tail stays readable', () => {
		// §6.10 keeps previous items forever, so year-old entries are normal, not
		// exotic — and "vor 400 Tagen" is arithmetic rather than an answer.
		setLocale('de');
		expect(relativeDays(13)).toBe('vor 13 Tagen');
		expect(relativeDays(14)).toBe('vor 2 Wochen');
		expect(relativeDays(59)).toBe('vor 8 Wochen');
		expect(relativeDays(60)).toBe('vor 2 Monaten');
		expect(relativeDays(364)).toBe('vor 12 Monaten');
		expect(relativeDays(365)).toBe('letztes Jahr');
		expect(relativeDays(800)).toBe('vor 2 Jahren');
	});

	it('never reports a unit smaller than a day', () => {
		// What [D-18] exists to prevent: a same-trip re-add must read
		// "heute", never "vor 3 Minuten".
		setLocale('de');
		for (const days of [0, 1, 5, 30, 400]) {
			expect(relativeDays(days)).not.toMatch(/Minute|Stunde|Sekunde/);
		}
	});
});
