// `formatDate`, the invite link's expiry ("Gültig bis …"): German keeps its
// numeric date, English names the month, since "12/09/2026" reads as
// 9 December to one reader and 12 September to another.
import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, getLocale, setLocale } from './index';

const original = getLocale();
afterEach(() => setLocale(original));

// Midday UTC, so the date is the same in every test machine's time zone.
const STAMP = '2026-12-09 12:00:00.000Z';

describe('formatDate', () => {
	it('writes German dates as numbers, day first', () => {
		setLocale('de');
		expect(formatDate(STAMP)).toBe('09.12.2026');
	});

	it('names the month in English, so the date reads one way only', () => {
		setLocale('en');
		expect(formatDate(STAMP)).toBe('Dec 9, 2026');
	});

	it('hands back what it cannot read', () => {
		expect(formatDate('not a date')).toBe('not a date');
	});
});
