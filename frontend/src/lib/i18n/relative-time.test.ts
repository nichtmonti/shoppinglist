// `relativeTime` — how long ago, as the sync line says it ([D-296]). Past a
// day it counts calendar days, since "gestern" names the day before today:
// 34 hours back from Wednesday 8:00 is Monday, not yesterday.
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, relativeTime, setLocale } from './index';

const original = getLocale();
afterEach(() => setLocale(original));

/** A local time on 14 Oct 2026 (a Wednesday), or `days` before it. */
const at = (hour: number, days = 0) => new Date(2026, 9, 14 - days, hour, 0).getTime();
const iso = (t: number) => new Date(t).toISOString();

describe('relativeTime', () => {
	it('counts calendar days, not 24-hour spans', () => {
		setLocale('de');
		const now = at(8);
		expect(relativeTime(iso(at(22, 2)), now)).toBe('vorgestern');
		expect(relativeTime(iso(at(7, 1)), now)).toBe('gestern');
		expect(relativeTime(iso(at(22, 1)), now)).toBe('vor 10 Stunden');
		expect(relativeTime(iso(at(9, 5)), now)).toBe('vor 5 Tagen');
	});

	it('says it the same way in English, short too', () => {
		setLocale('en');
		const now = at(8);
		expect(relativeTime(iso(at(22, 2)), now)).toBe('2 days ago');
		expect(relativeTime(iso(at(7, 1)), now)).toBe('yesterday');
		expect(relativeTime(iso(now - 25 * 60_000), now, 'short')).toBe('25 min. ago');
	});
});
