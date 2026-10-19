// The §9 typeahead ranking, without the component: AddBar's own suite covers
// rendering and the add/dedup flows; this one pins which names appear, in what
// order, and how much of each is bolded.
import { describe, expect, it } from 'vitest';

import type { Item, ItemDictionary } from './db';
import { makeItem } from './test-kit/db';
import {
	buildDictIndex,
	latestRowByKey,
	matchedPrefixLength,
	rankSuggestions,
	type Ranked
} from './typeahead';

const LIST = 'list-1';

function entry(de: string[], popularity = 1, en: string[] = de): ItemDictionary {
	return {
		id: `item_${de[0]}`,
		names_i18n: { de, en },
		default_category: 'produce',
		popularity
	};
}

function row(name: string, updated: string, overrides: Partial<Item> = {}): Item {
	return makeItem({ list: LIST, name, updated, ...overrides });
}

function rank(
	q: string,
	dictionary: ItemDictionary[],
	items: Item[] = [],
	suppressed: string[] = [],
	limit?: number
): Ranked[] {
	return rankSuggestions(
		q,
		buildDictIndex(dictionary, 'de'),
		latestRowByKey(items),
		suppressed,
		limit
	);
}

const names = (ranked: Ranked[]) =>
	ranked.map((r) => (r.kind === 'dict' ? `dict:${r.display}` : `pick:${r.item.name}`));

// [D-21]: a scanned row is filed under each of its names.
describe('rankSuggestions on a scanned row', () => {
	const scanned = row('Pâte à tartiner', '2026-09-01T00:00:00Z', {
		name_de: 'Nuss-Nougat-Creme',
		name_en: 'Nougat cream'
	});

	it('finds it by the name the viewer sees', () => {
		expect(names(rank('nuss', [], [scanned]))).toEqual(['pick:Pâte à tartiner']);
	});

	it('offers it once when several of its names match', () => {
		expect(rank('n', [], [scanned]).filter((r) => r.kind === 'pick')).toHaveLength(1);
	});

	it('hides it when the name the viewer sees is suppressed', () => {
		expect(rank('pât', [], [scanned], ['nuss-nougat-creme'])).toEqual([]);
	});
});

describe('rankSuggestions', () => {
	it('returns nothing for an empty query', () => {
		expect(rank('', [entry(['Sahne'])])).toEqual([]);
	});

	it('matches dictionary synonyms but shows the display name', () => {
		expect(names(rank('rahm', [entry(['Sahne', 'Rahm'])]))).toEqual(['dict:Sahne']);
	});

	it("represents a hit by this list's row, even when only a synonym matched", () => {
		const bought = row('Sahne', '2026-09-01T00:00:00Z', { checked: true });
		const ranked = rank('rahm', [entry(['Sahne', 'Rahm'])], [bought]);
		expect(ranked).toEqual([{ kind: 'pick', key: 'sahne', item: bought }]);
	});

	it('puts every row on this list before any dictionary entry, even one the cap would cut', () => {
		const dictionary = [
			entry(['Salat'], 3),
			entry(['Sahne'], 2),
			...['Salz', 'Salami', 'Salbei', 'Sardinen', 'Sauerkraut', 'Sahnejoghurt', 'Sago'].map((n) =>
				entry([n], 1)
			)
		];
		const ranked = rank('sa', dictionary, [
			row('Sahne', '2026-09-01T00:00:00Z'),
			row('Sanddornsaft', '2026-09-03T00:00:00Z')
		]);
		expect(ranked).toHaveLength(8);
		expect(names(ranked).slice(0, 3)).toEqual(['pick:Sanddornsaft', 'pick:Sahne', 'dict:Salat']);
	});

	it('orders rows newest first, whether or not the dictionary knows them', () => {
		const ranked = rank(
			'gur',
			[entry(['Gurke'], 3)],
			[
				row('Gurke', '2026-09-02T00:00:00Z'),
				row('Gurkensalat', '2026-09-01T00:00:00Z'),
				row('Gurkenwasser', '2026-09-03T00:00:00Z')
			]
		);
		expect(names(ranked)).toEqual(['pick:Gurkenwasser', 'pick:Gurke', 'pick:Gurkensalat']);
	});

	// Enter takes the top match (§9): typing a name exactly must add that name.
	it('puts the name typed exactly first, from the list or the dictionary', () => {
		const rows = [
			row('Milch', '2026-09-01T00:00:00Z'),
			row('Milchschokolade', '2026-09-03T00:00:00Z')
		];
		expect(names(rank('milch', [entry(['Milch'], 3)], rows)).slice(0, 2)).toEqual([
			'pick:Milch',
			'pick:Milchschokolade'
		]);
		// Only the dictionary has it: it still leads the list's own rows.
		expect(names(rank('milch', [entry(['Milch'], 3)], [rows[1]]))).toEqual([
			'dict:Milch',
			'pick:Milchschokolade'
		]);
		// A prefix still ranks as before.
		expect(names(rank('milc', [entry(['Milch'], 3)], rows))[0]).toBe('pick:Milchschokolade');
	});

	it('ranks a display-name match before a synonym-only match of higher popularity', () => {
		const dictionary = [entry(['Sahne', 'Rahm'], 3), entry(['Rahmspinat'], 1)];
		expect(names(rank('rahm', dictionary))).toEqual(['dict:Rahmspinat', 'dict:Sahne']);
	});

	it('ranks a row matching by its own name before a newer row matching only a synonym', () => {
		const ranked = rank(
			'rahm',
			[entry(['Sahne', 'Rahm']), entry(['Rahmspinat'])],
			[row('Sahne', '2026-09-05T00:00:00Z'), row('Rahmspinat', '2026-09-01T00:00:00Z')]
		);
		expect(names(ranked)).toEqual(['pick:Rahmspinat', 'pick:Sahne']);
	});

	it('offers one row per name — the most recently touched one', () => {
		const older = row('Eier', '2026-09-01T00:00:00Z');
		const newer = row('eier', '2026-09-05T00:00:00Z');
		const ranked = rank('ei', [entry(['Eier'])], [older, newer]);
		expect(ranked).toEqual([{ kind: 'pick', key: 'eier', item: newer }]);
	});

	it('never lists a row twice when it matches by its own name and a synonym', () => {
		const dictionary = [entry(['Sahne', 'Sahnesteif']), entry(['Sahnejoghurt'])];
		expect(names(rank('sahne', dictionary, [row('Sahne', '2026-09-01T00:00:00Z')]))).toEqual([
			'pick:Sahne',
			'dict:Sahnejoghurt'
		]);
	});

	it('hides a suppressed name from both sources (§6.11)', () => {
		const ranked = rank(
			'gur',
			[entry(['Gurke']), entry(['Gurkenwasser'])],
			[row('Gurkenwasser', '2026-09-01T00:00:00Z')],
			['gurkenwasser']
		);
		expect(names(ranked)).toEqual(['dict:Gurke']);
	});

	it('caps after suppression, so a hidden name does not cost a slot', () => {
		const dictionary = ['Aa', 'Ab', 'Ac'].map((n) => entry([n]));
		expect(names(rank('a', dictionary, [], ['aa'], 2))).toEqual(['dict:Ab', 'dict:Ac']);
	});
});

describe('buildDictIndex', () => {
	it('falls back to the English names when the locale has none', () => {
		const index = buildDictIndex(
			[{ id: 'item_x', names_i18n: { en: ['Tofu'] }, default_category: null, popularity: 1 }],
			'de'
		);
		expect(index).toEqual([
			{ display: 'Tofu', key: 'tofu', slug: null, popularity: 1, forms: ['tofu'] }
		]);
	});
});

describe('matchedPrefixLength', () => {
	it('is the length of the matched prefix of the name', () => {
		expect(matchedPrefixLength('Sahne', 'sa')).toBe(2);
	});

	it('is 0 when only a synonym matched', () => {
		expect(matchedPrefixLength('Sahne', 'rahm')).toBe(0);
	});

	it('is measured on the name, not the query, across collapsed whitespace', () => {
		expect(matchedPrefixLength('rote  Zwiebeln', 'rote z')).toBe(7);
	});

	it('is 0 for an empty query', () => {
		expect(matchedPrefixLength('Sahne', '')).toBe(0);
	});
});
