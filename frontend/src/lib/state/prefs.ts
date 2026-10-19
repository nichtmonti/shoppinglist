// Device-local view preferences (§9.3, §12), kept in Dexie `meta` and never
// synced; the home's list order is not a reopening of per-item ordering [D-19].
// Suggestion suppression, which is account-bound, is ./suppression.
import { getMeta, setMeta, type MetaKey, type MetaValues } from '#lib/db.js';
import { detectLocale, setLocale, type Locale } from '#lib/i18n/index.js';
import { live } from './live';

export type ListView = 'shop' | 'list';
export type ItemSort = 'az' | 'category';
export type HistorySort = 'recent' | ItemSort;
export type ListSort = 'activity' | 'alphabetical' | 'custom';
export type UiDensity = 'comfortable' | 'compact' | 'list';

/** A `meta`-backed preference: a live store (with its `loaded` flag) plus a setter. */
function pref<K extends MetaKey>(key: K, fallback: MetaValues[K]) {
	const store = live(async () => (await getMeta(key)) ?? fallback, fallback, `meta:${key}`);
	return Object.assign(store, { set: (value: MetaValues[K]) => setMeta(key, value) });
}

/** §9.1: the view a list opens in, the last used one, written only by the
 * in-list Einkaufen/Bearbeiten control; no settings surface ([D-101]). */
export const listView = pref('list_view', 'shop');

/** §9.1: shop-grid density, per device ([D-83]); `list` is full-width
 *  check-off rows without aisle headers, each led by its category ([D-313]). */
export const uiDensity = pref('ui_density', 'comfortable');

/** §9.1 [D-115]: an explicit choice applies to both views; null keeps the
 * defaults (both views by category, [D-115]). The legacy key keeps saved choices
 * without a migration. */
export const itemSort = pref('list_row_sort', null);

/** §6.10: the previous-items screen's own order, so choosing one there does
 * not rearrange the active list. */
export const historySort = pref('history_sort', 'recent');

/** §9.3: the home's ordering mode. Default = recent activity. */
export const listSort = pref('list_sort', 'activity');

/** §9.3: the manual home order — a device-local id array. */
export const listOrder = pref('list_order', []);

/** §12.2: the UI locale. */
export const localePref = pref('locale', detectLocale());

/** Set once the user dismisses the install prompt. */
export const installPromptDismissed = pref('install_prompt_dismissed', false);

/**
 * Apply the persisted locale at boot. `meta.locale` is written only by an
 * explicit choice in settings and outranks detectLocale() (§12.2). An
 * unreadable IndexedDB (site data blocked, WebKit's lost connection) falls
 * back to the detected locale: boot waits on this, and must still render
 * ([D-293]).
 */
export async function loadLocale(): Promise<Locale> {
	const stored = await getMeta('locale').catch(() => undefined);
	const locale = stored ?? detectLocale();
	setLocale(locale);
	return locale;
}

export async function setLocalePref(locale: Locale): Promise<void> {
	setLocale(locale);
	await localePref.set(locale);
}
