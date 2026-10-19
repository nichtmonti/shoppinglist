// The thin message indirection every UI string goes through (§12.2), over
// Paraglide compiled from messages/{locale}.json into #lib/paraglide/
// (generated).
//
// Locale strategy is `["globalVariable", "baseLocale"]`, no cookie or URL:
// `meta.locale` (#lib/state/prefs.ts) is the one source of truth, and
// Paraglide's own detection would compete with it.

import { m } from '#lib/paraglide/messages.js';
import { setLocale as paraglideSetLocale } from '#lib/paraglide/runtime.js';
import { activeLocale } from './active-locale.svelte';
import { calendarDaysBetween, DAY_MS, stampMs } from '#lib/time.js';

type MessageParams = Record<string, string | number>;

export type MessageKey = keyof typeof m;

/**
 * Resolve a message in the active locale, which a template or `$derived`
 * calling this then follows ([D-291]). The generated functions differ only in
 * their per-key `Inputs` type, which the cast collapses.
 */
export function t(key: MessageKey, params: MessageParams = {}): string {
	const fn = m[key] as (inputs?: MessageParams, options?: { locale?: Locale }) => string;
	return fn(params, { locale: activeLocale.value });
}

// ---- locale ------------------------------------------------------------

export type Locale = 'de' | 'en';

/**
 * The active locale, for `Intl` formatting and seeded vocabulary (§12.2), and
 * reactive like `t()`. #lib/state/prefs.ts persists it in `meta.locale`.
 */
export function getLocale(): Locale {
	return activeLocale.value;
}

/**
 * Switches every rendered string in place ([D-291]). `reload: false`:
 * Paraglide's default full-page reload would re-run app boot and the sync
 * engine mount. Its own global follows only for code that calls a message
 * without `t()`.
 */
export function setLocale(locale: Locale): void {
	activeLocale.value = locale;
	void paraglideSetLocale(locale, { reload: false });
}

/** navigator.language, but only when it asks for a locale this app HAS. */
function browserLocale(): Locale | null {
	const tag = (globalThis.navigator?.language ?? '').toLowerCase();
	if (tag.startsWith('de')) return 'de';
	if (tag.startsWith('en')) return 'en';
	return null;
}

/**
 * The language when the user has never chosen one (§12.2 [D-223]): the
 * browser's when the app speaks it, else `'en'`. Deliberately NOT persisted:
 * only an explicit choice in settings writes `meta.locale`.
 */
export function detectLocale(): Locale {
	return browserLocale() ?? 'en';
}

/** A locale-keyed seed value (`name_i18n`), falling back to `en`, then the
 *  slug (§12.2). */
export function localized(
	byLocale: Record<string, string> | undefined | null,
	slug: string
): string {
	if (!byLocale) return slug;
	return byLocale[getLocale()] ?? byLocale.en ?? slug;
}

// ---- locale-aware formatting (§12.2: no hand-rolled English formatters) ----

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * DAY_MS],
	['month', 30 * DAY_MS],
	['week', 7 * DAY_MS],
	['day', DAY_MS],
	['hour', 3600_000],
	['minute', 60_000]
];

/** Memoized per locale: constructing `Intl` formatters per row would dominate
 *  a list re-derive. */
const collators = new Map<Locale, Intl.Collator>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
const dateFormats = new Map<Locale, Intl.DateTimeFormat>();

/** A calendar date in the active locale's numeric form ("04.10.2026",
 *  "10/04/2026"); an unparseable input comes back as given. */
export function formatDate(iso: string): string {
	const locale = getLocale();
	let fmt = dateFormats.get(locale);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
		dateFormats.set(locale, fmt);
	}
	const ms = stampMs(iso);
	return ms === null ? iso : fmt.format(ms);
}

function relativeFormat(style: 'long' | 'short' = 'long'): Intl.RelativeTimeFormat {
	const locale = getLocale();
	const key = `${locale}:${style}`;
	let fmt = relativeFormats.get(key);
	if (!fmt) {
		// numeric:'auto' yields "gestern" rather than "vor 1 Tag".
		fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
		relativeFormats.set(key, fmt);
	}
	return fmt;
}

/** "heute" / "gestern" / "vor 3 Tagen": words a day count from `#lib/sorting.js`'s
 *  `daysAgo`, which owns the counting rules (clamp, missing stamp). */
export function relativeDays(days: number): string {
	const fmt = relativeFormat();
	// Coarsen past a fortnight: history is kept indefinitely (§6.10), and
	// "vor 13 Monaten" reads better than "vor 400 Tagen".
	if (days >= 365) return fmt.format(-Math.round(days / 365), 'year');
	if (days >= 60) return fmt.format(-Math.round(days / 30), 'month');
	if (days >= 14) return fmt.format(-Math.round(days / 7), 'week');
	return fmt.format(-days, 'day');
}

/**
 * "vor 3 Minuten" — `Intl.RelativeTimeFormat` in the active locale; "vor 3
 * Min." with `short`, for a line that must stay one line ([D-296]).
 */
export function relativeTime(
	iso: string | null | undefined,
	now = Date.now(),
	style: 'long' | 'short' = 'long'
): string {
	const then = stampMs(iso);
	if (then === null) return '';
	const deltaMs = then - now;
	const fmt = relativeFormat(style);
	for (const [unit, ms] of RELATIVE_UNITS) {
		if (Math.abs(deltaMs) < ms) continue;
		// Days are calendar days: "gestern" is the day before today, so 34
		// hours back from 8 o'clock is two days ago, not yesterday.
		if (unit === 'day') return fmt.format(calendarDaysBetween(now, then), unit);
		return fmt.format(Math.round(deltaMs / ms), unit);
	}
	return fmt.format(Math.round(deltaMs / 1000), 'second');
}

/** The §9.1 / §9.3 collator: `Ä/Ö/Ü` collate correctly, "Apfel 2" precedes "Apfel 10". */
export function collator(): Intl.Collator {
	const locale = getLocale();
	let coll = collators.get(locale);
	if (!coll) {
		coll = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
		collators.set(locale, coll);
	}
	return coll;
}
