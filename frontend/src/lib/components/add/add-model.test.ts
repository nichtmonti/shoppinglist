import { describe, expect, it } from 'vitest';

import { buildCorpus } from '#lib/classify.js';
import { makeItem } from '#lib/test-kit/db.js';
import { seedDictionary, seededCategories } from '#lib/test-kit/seed.js';
import { daysAgo } from '#lib/test-kit/time.js';
import { addableName, planAdd, resolveSuggestions, withTypedCandidate } from './add-model';

// The real seed, as every new list gets it (§7.5), so the classifier answers
// the way it does in the app.
const LIST = 'l1';
const categories = seededCategories(LIST);
const ctx = { categories, templates: new Map() };
const corpus = buildCorpus(seedDictionary, [], categories, 'de');

describe('resolveSuggestions', () => {
	it('shows a dictionary hit in its own aisle, and one with no such aisle in Others', () => {
		const [hit, stray] = resolveSuggestions(
			[
				{ kind: 'dict', key: 'milch', display: 'Milch', slug: 'dairy_eggs' },
				{ kind: 'dict', key: 'mi', display: 'Mizuna', slug: 'no_such_aisle' }
			],
			'mi',
			Date.now(),
			ctx
		);
		expect(hit).toMatchObject({ name: 'Milch', categorySlug: 'dairy_eggs', when: null });
		expect(hit.matchLength).toBe(2);
		expect(stray.icon).toBe(categories.find((c) => c.slug === 'other')!.icon);
	});

	it('dates a pick from this list, and only a pick', () => {
		const bought = makeItem({
			list: LIST,
			name: 'Hafermilch',
			last_bought_at: daysAgo(1)
		});
		const fresh = makeItem({ list: LIST, name: 'Haferflocken' });
		const [a, b] = resolveSuggestions(
			[
				{ kind: 'pick', key: 'hafermilch', item: bought },
				{ kind: 'pick', key: 'haferflocken', item: fresh }
			],
			'hafer',
			Date.now(),
			ctx
		);
		expect(a.when).toEqual(expect.any(String));
		expect(b.when).toBeNull();
		expect(a).toMatchObject({ key: 'hafermilch', categorySlug: null, matchLength: 5 });
	});
});

// [D-305] A suggestion that is the typed name already adds it.
describe('withTypedCandidate', () => {
	const suggest = (...names: string[]) =>
		resolveSuggestions(
			names.map((n) => ({ kind: 'dict', key: n.toLowerCase(), display: n, slug: null }) as const),
			'',
			Date.now(),
			ctx
		);
	const typedOf = (name: string, suggestions = suggest()) =>
		withTypedCandidate(suggestions, name, corpus, ctx).find((c) => c.typed);

	it('leaves the row out when a suggestion is the typed name, however spelled', () => {
		expect(typedOf('Kaffee', suggest('Kaffee', 'Kaffeebohnen'))).toBeUndefined();
		expect(typedOf('  kaffee ', suggest('Kaffee'))).toBeUndefined();
		expect(typedOf('   ')).toBeUndefined();
	});

	it('adds it last for a name no suggestion is', () => {
		const rows = withTypedCandidate(suggest('Kaffee', 'Kaffeebohnen'), 'Kaff', corpus, ctx);
		expect(rows.map((r) => r.name)).toEqual(['Kaffee', 'Kaffeebohnen', 'Kaff']);
		expect(rows[2]).toMatchObject({ typed: true, categorySlug: null, matchLength: 4 });
	});

	it('changes its key with the suggestions above it, so bits-ui re-highlights', () => {
		expect(typedOf('Kaff', suggest('Kaffee'))!.key).not.toBe(typedOf('Kaff')!.key);
	});
});

describe('the aisle an add lands in', () => {
	it('keeps a selected dictionary hit in its own aisle', () => {
		expect(planAdd('Vollmilchschokolade', 'dairy_eggs', [], categories, corpus)).toMatchObject({
			categoryKey: 'cat_dairy_eggs'
		});
	});

	it('classifies by head noun what no hit decided ([D-48])', () => {
		expect(planAdd('Vollmilchschokolade', null, [], categories, corpus)).toMatchObject({
			categoryKey: 'cat_snacks_sweets'
		});
	});

	it('previews the same aisle on the as-typed row, Others when there is no guess', () => {
		const icon = (slug: string) => categories.find((c) => c.slug === slug)!.icon;
		const typed = (name: string) => withTypedCandidate([], name, corpus, ctx)[0];
		expect(typed('Vollmilchschokolade').icon).toBe(icon('snacks_sweets'));
		expect(typed('Xyzzq').icon).toBe(icon('other'));
	});
});

describe('planAdd', () => {
	it('adds nothing for a name that is only whitespace', () => {
		expect(addableName('   ')).toBeNull();
		expect(addableName('  Milch ')).toBe('Milch');
	});

	it('finds the row a name already has instead of creating a second (§9.1)', () => {
		const milk = makeItem({ list: LIST, name: 'Milch', checked: true });
		expect(planAdd('milch', null, [milk], categories, corpus)).toEqual({
			kind: 'existing',
			item: milk
		});
	});

	it('creates a new name in its classified aisle', () => {
		expect(planAdd('Kirschjoghurt', null, [], categories, corpus)).toEqual({
			kind: 'create',
			name: 'Kirschjoghurt',
			categoryKey: 'cat_dairy_eggs'
		});
	});
});
