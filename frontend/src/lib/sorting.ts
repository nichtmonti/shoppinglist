// The item ordering and bucketing rules of §9, §9.1 and §6.10 as pure functions
// over rows, so every view sorts by the same code.
import type { CategoryTemplate, Item, ListCategory } from './db';
import { categoryOf, sortCategories } from './categories';
import { collator, relativeDays } from './i18n';
import { displayName } from './item-name';
import { calendarDaysBetween, stampMs } from './time';

// ---- the trip (§6.10, [D-18]) ----------------------------------------------
//
// A trip is found from the check-offs themselves, not from the clock, and is
// judged over the whole list on server stamps ([D-26]), so every device agrees.

/** How long a pause in checking things off ends a trip. */
export const TRIP_GAP_MS = 3 * 60 * 60 * 1000;

/** The start of the list's current trip — its earliest check-off — or null
 *  when no trip is current: nothing is checked, or the newest check-off is
 *  TRIP_GAP_MS old. */
function currentTripStart(items: Item[], now = Date.now()): number | null {
	const stamps = checkOffs(items);
	if (stamps.length === 0 || now - stamps[0] >= TRIP_GAP_MS) return null;
	let start = stamps[0];
	for (const ms of stamps) {
		if (start - ms >= TRIP_GAP_MS) break;
		start = ms;
	}
	return start;
}

/** When the current trip ends unless something else is checked off —
 *  TRIP_GAP_MS after its newest check-off — or null when no trip is current.
 *  What a live view schedules its re-sort on (#lib/state/clock). */
export function tripEndsAt(items: Item[], now = Date.now()): number | null {
	const stamps = checkOffs(items);
	if (stamps.length === 0 || now - stamps[0] >= TRIP_GAP_MS) return null;
	return stamps[0] + TRIP_GAP_MS;
}

/** The list's check-off stamps, newest first; a row without a usable one is
 *  long since checked and in no trip (see checkedAtMs). */
function checkOffs(items: Item[]): number[] {
	return livingItems(items)
		.filter((item) => item.checked)
		.map(checkedAtMs)
		.filter((ms) => ms > 0)
		.sort((a, b) => b - a);
}

/** Most recently touched first, by the row's `updated` stamp (ISO strings
 *  compare in time order). */
export function byUpdatedDesc(a: Pick<Item, 'updated'>, b: Pick<Item, 'updated'>): number {
	return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0;
}

/** Rows the UI must never show: server-stamped tombstones (§8.2). */
export function livingItems(items: Item[]): Item[] {
	return items.filter((i) => i.deleted_at === null);
}

/** §9.1/§9.2 dedup scope: everything on the list, plus the removed rows §6.10
 *  still remembers buying. Without the second half, typing a removed item's
 *  name would add a second row while the first still shows under "Frühere
 *  Artikel". */
export function livingOrRemembered(item: Item): boolean {
	return item.deleted_at === null || item.last_bought_at !== null;
}

/** The active list: unchecked, not tombstoned. */
export function activeItems(items: Item[]): Item[] {
	return items.filter((i) => i.deleted_at === null && !i.checked);
}

function checkedAtMs(item: Item): number {
	// A checked row without a usable stamp counts as long since checked ([D-79]):
	// only clearing the „Zuletzt" hints produces it, and treating it as just
	// checked would fake a purchase date that was just erased.
	return stampMs(item.checked_at) ?? 0;
}

/** §9.1 "recently checked": the list's current trip, newest first. */
export function recentlyChecked(items: Item[], now = Date.now()): Item[] {
	const start = currentTripStart(items, now);
	if (start === null) return [];
	// Each stamp is parsed once, not once per comparator call.
	return livingItems(items)
		.map((item) => [item, checkedAtMs(item)] as const)
		.filter(([item, ms]) => item.checked && ms >= start)
		.sort((a, b) => b[1] - a[1])
		.map(([item]) => item);
}

/** §6.10 [D-18]: is this row part of the list's purchase history? A living row
 *  when checked; a removed row when it was ever bought, because the row is the
 *  only record of the purchase. Not `livingOrRemembered`: a living unchecked
 *  row is matchable but is not history. */
function countsAsHistory(item: Item): boolean {
	return item.deleted_at === null ? item.checked : item.last_bought_at !== null;
}

/** The stamp §6.10 orders history by: the purchase when there is one, the
 *  check-off otherwise; `lastBoughtLabel` words the same stamp, so a row shows
 *  the date it is sorted by. The two differ only on a removed row that was re-added
 *  first (unchecking nulls `checked_at`, [D-26]); null sorts last ([D-79]). */
function historyStamp(item: Item): string | null {
	return item.last_bought_at ?? item.checked_at;
}

function historyStampMs(item: Item): number {
	return stampMs(historyStamp(item)) ?? 0;
}

/** §6.10 "previous items": everything this list remembers buying that is not on
 *  the active list, most recent first. The current trip's rows are in the done
 *  pile instead (`recentlyChecked`), so a row is in exactly one of the two; a
 *  removed row is never in the trip, so a mid-trip removal shows here. */
export function previousItems(items: Item[], now = Date.now()): Item[] {
	const trip = new Set(recentlyChecked(items, now));
	return items
		.filter((item) => countsAsHistory(item) && !trip.has(item))
		.map((item) => [item, historyStampMs(item)] as const)
		.sort((a, b) => b[1] - a[1])
		.map(([item]) => item);
}

/** §9.1's A→Z ordering, by the name the viewer sees ([D-21]). */
export function sortByName<T extends Parameters<typeof displayName>[0]>(rows: T[]): T[] {
	const coll = collator();
	return [...rows].sort((a, b) => coll.compare(displayName(a), displayName(b)));
}

interface AisleGroup {
	category: ListCategory;
	items: Item[];
}

/**
 * The §9 in-store grouping: items under the list's categories in aisle order
 * (`sortCategories`), A→Z within each, empty aisles dropped.
 */
export function groupByAisle(
	items: Item[],
	categories: ListCategory[],
	templates: Map<string, CategoryTemplate>
): AisleGroup[] {
	const ordered = sortCategories(
		categories.filter((c) => c.deleted_at === null),
		templates
	);
	const buckets = new Map<string, Item[]>();
	for (const item of items) {
		const category = categoryOf(item, categories);
		if (!category) continue;
		const bucket = buckets.get(category.id);
		if (bucket) bucket.push(item);
		else buckets.set(category.id, [item]);
	}
	return ordered
		.filter((category) => (buckets.get(category.id)?.length ?? 0) > 0)
		.map((category) => ({ category, items: sortByName(buckets.get(category.id) ?? []) }));
}

/** The item order both views show until the user picks one ([D-115]). */
export function itemSortOrDefault(chosen: 'az' | 'category' | null): 'az' | 'category' {
	return chosen ?? 'category';
}

/** Whole calendar days between a stamp and `now` (0 "heute", 1 "gestern"), or
 *  null for a missing or unparseable stamp ([D-18]). Clamped at 0 because a
 *  future stamp (server clock ahead) would read negative. */
export function daysAgo(iso: string | null | undefined, now = Date.now()): number | null {
	const ms = stampMs(iso);
	return ms === null ? null : Math.max(0, calendarDaysBetween(ms, now));
}

/** §6.10's "when did we last buy this" in the active locale ("vor 3 Tagen"),
 *  from `historyStamp`; null without a usable stamp. */
export function lastBoughtLabel(item: Item, now = Date.now()): string | null {
	const days = daysAgo(historyStamp(item), now);
	return days === null ? null : relativeDays(days);
}
