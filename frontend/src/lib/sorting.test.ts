// Sort order (the list's categories, Others-last, checked items dropping into
// the recently-checked section newest-first by `checked_at`) and alphabetical
// locale-collation. Tested here against the pure ordering
// functions; the view-level tests assert that the components render THIS order.
import { describe, expect, it } from 'vitest';
import { makeCategory, makeItem, makeTemplate } from './test-kit/db';
import {
	activeItems,
	groupByAisle,
	itemSortOrDefault,
	previousItems,
	recentlyChecked,
	daysAgo as calendarDaysAgo,
	sortByName,
	tripEndsAt,
	TRIP_GAP_MS
} from './sorting';
import { nextMidnight } from './time';
import { templateMap } from './categories';
import { setLocale } from './i18n';

const LIST = 'list-1';
const NOW = Date.parse('2026-07-26T12:00:00.000Z');

function daysAgo(days: number): string {
	return new Date(NOW - days * 24 * 3600 * 1000).toISOString();
}

const minutesAgo = (m: number, now = NOW): string => new Date(now - m * 60_000).toISOString();

/** A LOCAL wall-clock time on NOW's local day, so assertions about midnight or
 *  03:00 hold in whatever zone the suite runs in. */
function localAt(hours: number, minutes = 0, dayOffset = 0): number {
	const at = new Date(NOW);
	at.setDate(at.getDate() + dayOffset);
	at.setHours(hours, minutes, 0, 0);
	return at.getTime();
}

const checkedAt = (name: string, ms: number) =>
	makeItem({ list: LIST, name, checked: true, checked_at: new Date(ms).toISOString() });
const names = (items: { name: string }[]) => items.map((i) => i.name);

describe('active / checked bucketing (§6.10)', () => {
	it('keeps unchecked, non-tombstoned rows in the active list', () => {
		const items = [
			makeItem({ list: LIST, name: 'Milch' }),
			makeItem({ list: LIST, name: 'Brot', checked: true, checked_at: daysAgo(1) }),
			makeItem({ list: LIST, name: 'Gelöscht', deleted_at: daysAgo(0) })
		];

		expect(activeItems(items).map((i) => i.name)).toEqual(['Milch']);
	});

	it('orders the recently-checked section newest-first by checked_at', () => {
		const items = [
			makeItem({ list: LIST, name: 'Zuerst', checked: true, checked_at: minutesAgo(70) }),
			makeItem({ list: LIST, name: 'Zuletzt', checked: true, checked_at: minutesAgo(10) }),
			makeItem({ list: LIST, name: 'Mitte', checked: true, checked_at: minutesAgo(40) })
		];

		expect(names(recentlyChecked(items, NOW))).toEqual(['Zuletzt', 'Mitte', 'Zuerst']);
	});

	it('ends a trip at a pause of TRIP_GAP_MS, and files what came before as previous', () => {
		// The current trip is the run back from the newest tick; a pause of the
		// full gap closes the earlier one.
		const gapMin = TRIP_GAP_MS / 60_000;
		const items = [
			makeItem({ list: LIST, name: 'Jetzt', checked: true, checked_at: minutesAgo(5) }),
			makeItem({ list: LIST, name: 'Vorhin', checked: true, checked_at: minutesAgo(60) }),
			makeItem({ list: LIST, name: 'Davor', checked: true, checked_at: minutesAgo(60 + gapMin) })
		];

		expect(names(recentlyChecked(items, NOW))).toEqual(['Jetzt', 'Vorhin']);
		expect(names(previousItems(items, NOW))).toEqual(['Davor']);
	});

	it('keeps a trip together however long it runs, as long as nobody pauses', () => {
		// Four hours from first to last tick, never more than two between two:
		// one trip, so the first row has not aged out on its own ([D-18]'s
		// point: a trip leaves the pile together).
		const items = [
			checkedAt('A', NOW - 240 * 60_000),
			checkedAt('B', NOW - 120 * 60_000),
			checkedAt('C', NOW - 10 * 60_000)
		];

		expect(names(recentlyChecked(items, NOW))).toEqual(['C', 'B', 'A']);
		expect(previousItems(items, NOW)).toEqual([]);
	});

	it('keeps a shop that runs past 03:00 one trip', () => {
		// The case the 03:00 hour split in two ([D-18]).
		const now = localAt(3, 20);
		const items = [
			checkedAt('Vor drei', localAt(2, 40)),
			checkedAt('Um drei', localAt(2, 58)),
			checkedAt('Nach drei', localAt(3, 10))
		];

		expect(names(recentlyChecked(items, now))).toEqual(['Nach drei', 'Um drei', 'Vor drei']);
		expect(previousItems(items, now)).toEqual([]);
	});

	it('keeps a shop that runs past midnight one trip', () => {
		const now = localAt(0, 40);
		const items = [checkedAt('Spät', localAt(23, 50, -1)), checkedAt('Später', localAt(0, 20))];

		expect(names(recentlyChecked(items, now))).toEqual(['Später', 'Spät']);
	});

	it('makes two shops on one day two trips', () => {
		const now = localAt(18, 30);
		const items = [checkedAt('Morgens', localAt(9, 0)), checkedAt('Abends', localAt(18, 15))];

		expect(names(recentlyChecked(items, now))).toEqual(['Abends']);
		expect(names(previousItems(items, now))).toEqual(['Morgens']);
	});

	it('empties the done pile TRIP_GAP_MS after the last tick', () => {
		const last = checkedAt('Letzter', NOW - 10 * 60_000);
		const ends = NOW - 10 * 60_000 + TRIP_GAP_MS;

		expect(names(recentlyChecked([last], ends - 1))).toEqual(['Letzter']);
		expect(recentlyChecked([last], ends)).toEqual([]);
		expect(names(previousItems([last], ends))).toEqual(['Letzter']);
	});

	it('names when the current trip ends, for the live views to wake on', () => {
		const items = [checkedAt('A', NOW - 50 * 60_000), checkedAt('B', NOW - 20 * 60_000)];

		expect(tripEndsAt(items, NOW)).toBe(NOW - 20 * 60_000 + TRIP_GAP_MS);
		expect(tripEndsAt(items, NOW + TRIP_GAP_MS)).toBeNull();
		expect(tripEndsAt([], NOW)).toBeNull();
		// Unchecked rows are no check-off.
		expect(tripEndsAt([makeItem({ list: LIST, name: 'Offen' })], NOW)).toBeNull();
	});

	it('keeps a tombstoned row that was NEVER bought out of both buckets', () => {
		// §6.10's "a removed item was never bought" holds for exactly this case:
		// no last_bought_at, so there is no purchase to remember and the row is
		// simply gone.
		const removed = makeItem({
			list: LIST,
			name: 'Entfernt',
			checked: true,
			checked_at: daysAgo(1),
			deleted_at: daysAgo(0)
		});

		expect(recentlyChecked([removed], NOW)).toEqual([]);
		expect(previousItems([removed], NOW)).toEqual([]);
	});

	it('keeps a removed row the list REMEMBERS BUYING in previous items', () => {
		// Bought yesterday, re-added from "Frühere Artikel" (which clears
		// checked/checked_at but keeps last_bought_at, §6.6), then removed again
		// because it turned out not to be wanted. The row IS the history here, so
		// tombstoning it must not erase the purchase with it.
		const readdedThenRemoved = makeItem({
			list: LIST,
			name: 'Haselnussmus',
			checked: false,
			checked_at: null,
			last_bought_at: daysAgo(1),
			deleted_at: daysAgo(0)
		});

		expect(previousItems([readdedThenRemoved], NOW).map((i) => i.name)).toEqual(['Haselnussmus']);
	});

	it('never puts a removed row in the recently-checked section, even bought today', () => {
		// "Erledigt" means ticked on THIS trip, and a removed row was not
		// ticked — so it goes straight to previous items regardless of the trip.
		// Holding it back for the trip too would hide a removal made mid-trip
		// from both surfaces until the trip ended.
		const removedToday = makeItem({
			list: LIST,
			name: 'Sahne',
			checked: false,
			checked_at: null,
			last_bought_at: minutesAgo(90),
			deleted_at: minutesAgo(30)
		});

		expect(recentlyChecked([removedToday], NOW)).toEqual([]);
		expect(previousItems([removedToday], NOW).map((i) => i.name)).toEqual(['Sahne']);
	});

	it('orders a removed row by its purchase, not by its nulled checked_at', () => {
		// Re-adding nulled checked_at, so ordering on that stamp alone would sink
		// every removed row to the bottom next to the [D-79] cleared ones.
		const removed = makeItem({
			list: LIST,
			name: 'Mitte',
			checked: false,
			checked_at: null,
			last_bought_at: daysAgo(2),
			deleted_at: daysAgo(0)
		});
		const newer = makeItem({ list: LIST, name: 'Neu', checked: true, checked_at: daysAgo(1) });
		const older = makeItem({ list: LIST, name: 'Alt', checked: true, checked_at: daysAgo(3) });

		expect(previousItems([older, removed, newer], NOW).map((i) => i.name)).toEqual([
			'Neu',
			'Mitte',
			'Alt'
		]);
	});

	it('keeps a checked row with a null checked_at in previous items, not recently checked', () => {
		// [D-79] „Kaufdaten zurücksetzen" nulls the stamps; a checked row
		// without one counts as long-since-checked (§6.10 "Frühere Artikel").
		const cleared = makeItem({ list: LIST, name: 'Gelöscht', checked: true, checked_at: null });

		expect(recentlyChecked([cleared], NOW)).toEqual([]);
		expect(previousItems([cleared], NOW).map((i) => i.name)).toEqual(['Gelöscht']);
	});

	it('sorts a null-stamped row after stamped old rows in previous items', () => {
		const cleared = makeItem({ list: LIST, name: 'Gelöscht', checked: true, checked_at: null });
		const stamped = makeItem({ list: LIST, name: 'Alt', checked: true, checked_at: daysAgo(30) });

		expect(previousItems([cleared, stamped], NOW).map((i) => i.name)).toEqual(['Alt', 'Gelöscht']);
	});

	it('treats an unparseable checked_at like null', () => {
		const bad = makeItem({ list: LIST, name: 'Kaputt', checked: true, checked_at: 'nope' });

		expect(recentlyChecked([bad], NOW)).toEqual([]);
		expect(previousItems([bad], NOW).map((i) => i.name)).toEqual(['Kaputt']);
	});
});

describe('alphabetical locale-collation (§9.1)', () => {
	it('collates umlauts with their base letter', () => {
		setLocale('de');
		const items = ['Zucker', 'Äpfel', 'Butter', 'Öl'].map((name) => makeItem({ list: LIST, name }));

		expect(sortByName(items).map((i) => i.name)).toEqual(['Äpfel', 'Butter', 'Öl', 'Zucker']);
	});

	it('sorts embedded numbers numerically, not lexically', () => {
		setLocale('de');
		const items = ['Apfel 10', 'Apfel 2'].map((name) => makeItem({ list: LIST, name }));

		expect(sortByName(items).map((i) => i.name)).toEqual(['Apfel 2', 'Apfel 10']);
	});

	// [D-21]: a scanned item sorts under the name the viewer sees.
	it('orders a scanned item by its name in the UI language', () => {
		const scanned = makeItem({ list: LIST, name: 'Zzz import', name_de: 'Brot', name_en: 'Bread' });
		const items = [scanned, makeItem({ list: LIST, name: 'Käse' })];

		setLocale('de');
		expect(sortByName(items).map((i) => i.name)).toEqual(['Zzz import', 'Käse']);
		setLocale('en');
		expect(sortByName(items).map((i) => i.name)).toEqual(['Zzz import', 'Käse']);
		setLocale('de');
	});
});

describe('aisle grouping (§9, §6.7)', () => {
	const produce = makeCategory({ list: LIST, slug: 'produce', name: 'Obst', sort_order: 1 });
	const dairy = makeCategory({ list: LIST, slug: 'dairy_eggs', name: 'Milch', sort_order: 3 });
	// Others carries the seed's sort_order 17 here, but the rule under test is
	// that its POSITION does not depend on that number.
	const others = makeCategory({ list: LIST, slug: 'other', name: null, sort_order: 2 });
	const templates = templateMap([makeTemplate({ slug: 'other' })]);

	it('orders aisles by sort_order with Others always last', () => {
		const items = [
			makeItem({ list: LIST, name: 'Joghurt', category_key: dairy.id }),
			makeItem({ list: LIST, name: 'Kerzen', category_key: others.id }),
			makeItem({ list: LIST, name: 'Apfel', category_key: produce.id })
		];

		const groups = groupByAisle(items, [dairy, others, produce], templates);
		expect(groups.map((g) => g.category.slug)).toEqual(['produce', 'dairy_eggs', 'other']);
	});

	it('drops items with a null, hidden or unknown category into Others', () => {
		const hidden = makeCategory({ list: LIST, slug: null, name: 'Weg', deleted_at: daysAgo(1) });
		const items = [
			makeItem({ list: LIST, name: 'Ohne', category_key: null }),
			makeItem({ list: LIST, name: 'Versteckt', category_key: hidden.id }),
			makeItem({ list: LIST, name: 'Fremd', category_key: 'does-not-exist' })
		];

		const groups = groupByAisle(items, [produce, others, hidden], templates);
		expect(groups).toHaveLength(1);
		expect(groups[0].category.slug).toBe('other');
		expect(groups[0].items.map((i) => i.name)).toEqual(['Fremd', 'Ohne', 'Versteckt']);
	});

	it('sorts A→Z within an aisle and skips empty aisles', () => {
		const items = [
			makeItem({ list: LIST, name: 'Zwiebel', category_key: produce.id }),
			makeItem({ list: LIST, name: 'Ananas', category_key: produce.id })
		];

		const groups = groupByAisle(items, [produce, dairy, others], templates);
		expect(groups.map((g) => g.category.slug)).toEqual(['produce']);
		expect(groups[0].items.map((i) => i.name)).toEqual(['Ananas', 'Zwiebel']);
	});
});

describe('daysAgo (§6.10, [D-18])', () => {
	it('counts calendar days, not elapsed 24h blocks', () => {
		// 23:30 yesterday, read at 00:30: an hour ago, and "gestern".
		expect(calendarDaysAgo(new Date(localAt(23, 30, -1)).toISOString(), localAt(0, 30))).toBe(1);
		// 00:30 today, read at 23:30: 23 hours ago, and "heute".
		expect(calendarDaysAgo(new Date(localAt(0, 30)).toISOString(), localAt(23, 30))).toBe(0);
	});

	it('reads an earlier shop the same day as today', () => {
		// A morning trip seen in the evening is a previous item, and "heute".
		expect(calendarDaysAgo(new Date(localAt(9, 0)).toISOString(), localAt(18, 0))).toBe(0);
	});

	it('has no upper bound — a year-old purchase still answers', () => {
		expect(calendarDaysAgo(daysAgo(9), NOW)).toBe(9);
		expect(calendarDaysAgo(daysAgo(400), NOW)).toBe(400);
	});

	it('clamps a future stamp to 0, never a negative count', () => {
		// Clock skew (server ahead of the device) or a hand-edited import would
		// otherwise read negative — "morgen" wording on a purchase date.
		expect(calendarDaysAgo(new Date(localAt(12, 0, 1)).toISOString(), NOW)).toBe(0);
		expect(calendarDaysAgo(daysAgo(-30), NOW)).toBe(0);
	});

	it('survives a DST step, where two midnights are 23 or 25 hours apart', () => {
		const march = Date.parse('2026-03-30T12:00:00.000Z');
		const at = new Date(march);
		at.setDate(at.getDate() - 1);
		expect(calendarDaysAgo(at.toISOString(), march)).toBe(1);
	});

	it('is null for a missing or unparseable stamp, never 0', () => {
		// 0 would render as "heute" — a purchase date invented for a row that has
		// none, which is exactly what [D-79] says must not happen after a clear.
		expect(calendarDaysAgo(null, NOW)).toBeNull();
		expect(calendarDaysAgo(undefined, NOW)).toBeNull();
		expect(calendarDaysAgo('nope', NOW)).toBeNull();
	});

	it('wakes the wording at the next local midnight, a calendar day on', () => {
		const next = new Date(nextMidnight(NOW));
		expect(next.getHours()).toBe(0);
		expect(next.getMinutes()).toBe(0);
		expect(next.getTime()).toBeGreaterThan(NOW);
		expect(next.getTime() - NOW).toBeLessThanOrEqual(25 * 3600_000);
	});
});

describe('itemSortOrDefault ([D-115])', () => {
	it('defaults to aisles in both views', () => {
		expect(itemSortOrDefault(null)).toBe('category');
	});

	it('keeps an explicit choice', () => {
		expect(itemSortOrDefault('az')).toBe('az');
		expect(itemSortOrDefault('category')).toBe('category');
	});
});
