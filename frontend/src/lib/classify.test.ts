// The head-noun classifier (§9 auto-categorisation for novel names).
//
// The vector suite runs against the REAL seed — backend/seed/items.json, the
// same entries every install mirrors into Dexie — rather than a hand-built
// toy dictionary. The whole feature is a claim about that specific vocabulary,
// so a fixture that invented its own would prove nothing about the app, and the
// two tuning constants (MIN_HEAD, MIN_HEAD_SHARE) would drift unnoticed.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	buildCorpus,
	classify,
	foldForMatch,
	grammarFor,
	GRAMMARS,
	type Corpus,
	type Grammar
} from './classify';
import type { Item } from './db';
import { makeCategory, makeItem } from './test-kit/db';
import { seedDictionary as seedItems, seededCategories } from './test-kit/seed';

interface Vector {
	in: string;
	expect: string | null;
	note: string;
}

const vectors = JSON.parse(
	readFileSync(new URL('./classify-vectors.json', import.meta.url), 'utf-8')
) as Vector[];

const LIST = 'list-1';

/** Vectors name a slug; the classifier answers with a list_categories row id. */
function slugOf(categoryKey: string | null): string | null {
	return categoryKey === null ? null : categoryKey.replace(/^cat_/, '');
}

const categories = seededCategories(LIST);
const dictionaryOnly = buildCorpus(seedItems, [], categories, 'de');

describe('classify — vectors over the real seed dictionary', () => {
	it('has vectors, a dictionary and a category set to check', () => {
		expect(vectors.length).toBeGreaterThan(0);
		// Sanity bounds, not exact pins: the authoritative derived counts live in
		// backend/seed/seed_test.go, so a seed append must
		// not require touching this file. These still catch a broken JSON load.
		expect(seedItems.length).toBeGreaterThan(300);
		expect(categories.length).toBeGreaterThan(10);
	});

	for (const v of vectors) {
		it(`${JSON.stringify(v.in)} → ${v.expect ?? 'Others'} (${v.note})`, () => {
			expect(slugOf(classify(v.in, dictionaryOnly))).toBe(v.expect);
		});
	}
});

describe('foldForMatch', () => {
	it('folds what normalizeName deliberately does not', () => {
		// [D-44] keeps these distinct because it decides server-side merges; this
		// function has the opposite cost asymmetry, so it may fold freely.
		expect(foldForMatch('Müsli')).toBe(foldForMatch('Muesli'));
		expect(foldForMatch('Weißbrot')).toBe(foldForMatch('Weissbrot'));
		expect(foldForMatch('Bio-Tomaten')).toBe(foldForMatch('BioTomaten'));
		expect(foldForMatch('Crème fraîche')).toBe('creme fraiche');
	});

	it('collapses to empty when nothing letterlike survives', () => {
		expect(foldForMatch('🍫 —')).toBe('');
	});
});

describe('buildCorpus', () => {
	it('skips dictionary entries whose slug this list has no live row for', () => {
		const withoutSweets = categories.filter((c) => c.slug !== 'snacks_sweets');
		const corpus = buildCorpus(seedItems, [], withoutSweets, 'de');
		expect(classify('Vollmilchschokolade', corpus)).toBeNull();
	});

	it('files a TK name by its head when the list has no frozen aisle', () => {
		const withoutFrozen = categories.filter((c) => c.slug !== 'frozen');
		const corpus = buildCorpus(seedItems, [], withoutFrozen, 'de');
		expect(slugOf(classify('TK Himbeeren', corpus))).toBe('produce');
	});

	it('skips tombstoned category rows', () => {
		const hidden = categories.map((c) =>
			c.slug === 'snacks_sweets' ? { ...c, deleted_at: new Date().toISOString() } : c
		);
		expect(classify('Vollmilchschokolade', buildCorpus(seedItems, [], hidden, 'de'))).toBeNull();
	});

	it('ignores items filed under Others — the fallback bucket carries no signal', () => {
		const items = [makeItem({ list: LIST, name: 'Grillmarinade', category_key: 'cat_other' })];
		expect(
			classify('Bio-Grillmarinade', buildCorpus(seedItems, items, categories, 'de'))
		).toBeNull();
	});

	it('ignores tombstoned items and items pointing at a dangling key', () => {
		const items = [
			makeItem({
				list: LIST,
				name: 'Grillmarinade',
				category_key: 'cat_pantry',
				deleted_at: new Date().toISOString()
			}),
			makeItem({ list: LIST, name: 'Grillsauce', category_key: 'cat_gone' })
		];
		expect(
			classify('Bio-Grillmarinade', buildCorpus(seedItems, items, categories, 'de'))
		).toBeNull();
	});

	// The dictionary half is reused while the dictionary and categories stay the
	// same arrays; it must be exactly what a from-scratch build produces, order
	// included, whatever the items are.
	it('reuses the dictionary half without changing the corpus', () => {
		const itemsA = [makeItem({ list: LIST, name: 'Grillmarinade', category_key: 'cat_pantry' })];
		const itemsB = [
			makeItem({ list: LIST, name: 'Ziegenkäse', category_key: 'cat_dairy_eggs' }),
			...itemsA
		];
		buildCorpus(seedItems, itemsA, categories, 'de');
		const reused = buildCorpus(seedItems, itemsB, categories, 'de');
		// Fresh copies share no identity with the memo, so this one is built in full.
		const fresh = buildCorpus(
			structuredClone(seedItems),
			itemsB,
			structuredClone(categories),
			'de'
		);
		expect(reused).toEqual(fresh);
		expect(reused.candidates.slice(0, 2).every((c) => c.learned)).toBe(true);
	});

	it('rebuilds the dictionary half when the categories change', () => {
		buildCorpus(seedItems, [], categories, 'de');
		const withoutSweets = categories.filter((c) => c.slug !== 'snacks_sweets');
		expect(
			classify('Vollmilchschokolade', buildCorpus(seedItems, [], withoutSweets, 'de'))
		).toBeNull();
		expect(
			slugOf(classify('Vollmilchschokolade', buildCorpus(seedItems, [], categories, 'de')))
		).toBe('snacks_sweets');
	});
});

describe('classify — learning from the list itself', () => {
	function corpusWith(items: Item[]): Corpus {
		return buildCorpus(seedItems, items, categories, 'de');
	}

	it('categorises a name the seed cannot, from the household vocabulary', () => {
		// The seed has no "Marinade", so the head is unreachable from the
		// dictionary alone. One past Grillmarinade on this list is enough to
		// teach it.
		expect(classify('Bio-Grillmarinade', dictionaryOnly)).toBeNull();
		const items = [makeItem({ list: LIST, name: 'Grillmarinade', category_key: 'cat_pantry' })];
		expect(slugOf(classify('Bio-Grillmarinade', corpusWith(items)))).toBe('pantry');
	});

	it('learns a list-specific custom category, which the seed cannot express', () => {
		const custom = makeCategory({ list: LIST, id: 'cat_custom', slug: null, name: 'Hofladen' });
		const items = [makeItem({ list: LIST, name: 'Ziegenkäse', category_key: 'cat_custom' })];
		const corpus = buildCorpus(seedItems, items, [...categories, custom], 'de');
		expect(classify('Schafsziegenkäse', corpus)).toBe('cat_custom');
	});

	it('prefers the learned aisle over the seeded one at equal head length', () => {
		// This household files Milch somewhere the seed would not. "Erdnussmilch"
		// is not itself a dictionary entry, so both sources offer the same 5-char
		// head — and provenance decides.
		expect(slugOf(classify('Erdnussmilch', dictionaryOnly))).toBe('dairy_eggs');
		const items = [makeItem({ list: LIST, name: 'Milch', category_key: 'cat_frozen' })];
		expect(slugOf(classify('Erdnussmilch', corpusWith(items)))).toBe('frozen');
	});

	it('does not let a learned head override a whole-name dictionary hit', () => {
		// "Hafermilch" IS in the seed, so the exact tier wins outright — a learned
		// "Milch" filed elsewhere is a 5-char compound head and ranks below it.
		const items = [makeItem({ list: LIST, name: 'Milch', category_key: 'cat_frozen' })];
		expect(slugOf(classify('Hafermilch', corpusWith(items)))).toBe('dairy_eggs');
	});

	it('keeps the most recently touched row when a name was filed twice', () => {
		const items = [
			makeItem({
				list: LIST,
				name: 'Milch',
				category_key: 'cat_frozen',
				updated: '2026-07-01T00:00:00.000Z'
			}),
			makeItem({
				list: LIST,
				name: 'Milch',
				category_key: 'cat_beverages',
				updated: '2026-07-20T00:00:00.000Z'
			})
		];
		expect(slugOf(classify('Erdnussmilch', corpusWith(items)))).toBe('beverages');
	});

	it('keeps a frozen-marked name where the list filed it', () => {
		// "TK" or "Tiefkühl" sends a name to the frozen aisle, but not one this
		// list already filed somewhere else.
		const items = [makeItem({ list: LIST, name: 'TK Hundefutter', category_key: 'cat_pet' })];
		expect(slugOf(classify('TK Hundefutter', dictionaryOnly))).toBe('frozen');
		expect(slugOf(classify('TK Hundefutter', corpusWith(items)))).toBe('pet');
		expect(slugOf(classify('TK Himbeeren', corpusWith(items)))).toBe('frozen');
	});

	it('still prefers a longer head over a learned shorter one', () => {
		// Length of the matched head outranks provenance: "schokolade" (10) beats
		// a learned "milch" (5) even though learned names win ties.
		const items = [makeItem({ list: LIST, name: 'Milch', category_key: 'cat_frozen' })];
		expect(slugOf(classify('Vollmilchschokolade', corpusWith(items)))).toBe('snacks_sweets');
	});
});

describe('classify — the whole-name tier outranks compound heads', () => {
	it('takes an exact hit over a longer head found inside it', () => {
		// Both are available for "Kartoffelsalat" if the list has bought one before.
		const items = [makeItem({ list: LIST, name: 'Kartoffelsalat', category_key: 'cat_frozen' })];
		expect(
			slugOf(classify('Kartoffelsalat', buildCorpus(seedItems, items, categories, 'de')))
		).toBe('frozen');
	});

	it('never matches a fragment of a known name', () => {
		// "joghu" is a prefix of Joghurt, not a head — nothing may match it.
		expect(classify('Erdbeerjoghu', dictionaryOnly)).toBeNull();
	});

	it('returns null rather than guessing from an empty corpus', () => {
		expect(
			classify('Vollmilchschokolade', { candidates: [], grammar: grammarFor('de') })
		).toBeNull();
	});
});

describe('the grammars', () => {
	it('keeps each language to its own rules', () => {
		expect(GRAMMARS.de.details.has('mit')).toBe(true);
		expect(GRAMMARS.de.details.has('with')).toBe(false);
		expect(GRAMMARS.en.details.has('with')).toBe(true);
		expect(GRAMMARS.en.frozen('tk')).toBe(false);
	});

	// Plurals are tried in the tails' loop, whose order decides ties.
	it('makes every plural a tail as well, in every language', () => {
		for (const grammar of Object.values(GRAMMARS)) {
			for (const plural of grammar.plurals) expect(grammar.tails).toContain(plural);
		}
	});

	it('reads a name by German and English rules under either app language', () => {
		for (const locale of ['de', 'en'] as const) {
			const corpus = buildCorpus(seedItems, [], categories, locale);
			expect(slugOf(classify('Müsli ohne Zucker', corpus))).toBe('breakfast');
			expect(slugOf(classify('pasta with pesto', corpus))).toBe('pasta_rice');
			expect(slugOf(classify('TK Himbeeren', corpus))).toBe('frozen');
			expect(slugOf(classify('frozen broccoli', corpus))).toBe('frozen');
		}
	});

	it('takes every rule from the corpus, and every name from every language', () => {
		const corpus = buildCorpus(seedItems, [], categories, 'de');
		const without = (rules: Partial<Grammar>) => ({
			...corpus,
			grammar: { ...corpus.grammar, ...rules }
		});
		expect(slugOf(classify('Müsli ohne Zucker', without({ details: new Set() })))).toBe(
			'baking_spices'
		);
		expect(slugOf(classify('TK Himbeeren', without({ frozen: () => false })))).toBe('produce');
		expect(classify('Salzkartoffeln', without({ tails: [], plurals: [] }))).toBeNull();
		// Without the added plural, "Erdbeere" loses its -e and ends in "beer".
		expect(slugOf(classify('Erdbeere', without({ plurals: [] })))).toBe('alcohol');
		expect(slugOf(classify('Erdbeere', corpus))).toBe('produce');
		// An English name on a German list still finds its aisle.
		expect(slugOf(classify('chocolate milk', corpus))).toBe('dairy_eggs');
	});
});
