// Calendar-day arithmetic in local time and the one way a server stamp is
// parsed. Imports nothing, so `sorting`, `i18n` and `backup` can all use it.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight at the start of the calendar day `now` falls in. */
export function startOfDay(now: number): number {
	return new Date(now).setHours(0, 0, 0, 0);
}

/** The next local midnight — when "heute" becomes "gestern". DST-safe: it
 *  steps a calendar day rather than adding 24h. */
export function nextMidnight(now = Date.now()): number {
	const at = new Date(startOfDay(now));
	at.setDate(at.getDate() + 1);
	return at.getTime();
}

/** Local midnights from `from` to `to`, negative when `to` is earlier.
 *  Math.round because two midnights are 23 or 25 hours apart across a DST
 *  change. */
export function calendarDaysBetween(from: number, to: number): number {
	return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

/** An ISO stamp in epoch ms, or null when it is missing or does not parse.
 *  PocketBase writes a space where ISO has its `T`; both parse. */
export function stampMs(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const ms = new Date(iso.replace(' ', 'T')).getTime();
	return Number.isNaN(ms) ? null : ms;
}
