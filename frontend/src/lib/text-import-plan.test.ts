// [D-254] what a text list becomes on a list: the aisle each item lands in, and
// what the target already has. Against the REAL seed (dictionary and roster),
// like classify.test.ts: the placement is a claim about that vocabulary.
import { describe, expect, it } from 'vitest';

import { templateMap } from './categories';
import { makeCategory, makeItem } from './test-kit/db';
import { seedDictionary, seedTemplates, seededCategories } from './test-kit/seed';
import { parseTextList } from './text-import';
import {
	aisleChoice,
	backupFromPlan,
	groupRows,
	isSelected,
	planImport,
	rosterCategories,
	rowAsItem,
	selectable,
	statusNote,
	withPatch,
	type PlanRow,
	type PlanTarget
} from './text-import-plan';
import { t as message } from './i18n';
import { parseListBackup } from './backup';

const dictionary = seedDictionary;
const templates = seedTemplates;

const EINKAUFSLISTE = `Hamburg


[Obst - Gemüse - Nüsse]
Mango
Paprika, rot

[Saucen - Gewürze - Dressings - Öle]
Gelbe currypaste

[Backwaren]
Brot

[Brotaufstrich]
Ahornsirup

[Müsli - Cornflakes - Cerealien]
Chiasamen
Sonnenblumenkerne

[Kühltheke - Milchprodukte]
Erbsenmilch
`;

function newListTarget(): PlanTarget {
	return {
		categories: rosterCategories(templates),
		items: [],
		dictionary,
		templates: templateMap(templates),
		locale: 'de'
	};
}

/** A list whose categories are the seed copy, with ids `cat_<slug>`. */
function existingTarget(items: ReturnType<typeof makeItem>[] = []): PlanTarget {
	return {
		categories: seededCategories('L'),
		items,
		dictionary,
		templates: templateMap(templates),
		locale: 'de'
	};
}

describe('planImport', () => {
	it('builds the new list from the current aisles, without a retired one [D-300]', () => {
		const slugs = rosterCategories(templates).map((c) => c.slug);
		expect(slugs).toContain('coffee_tea');
		expect(slugs).not.toContain('garden');
	});

	it('places every item of the Die Einkaufsliste share in one of our aisles', () => {
		const rows = planImport(parseTextList(EINKAUFSLISTE).entries, newListTarget());
		expect(Object.fromEntries(rows.map((r) => [r.name, r.categoryKey]))).toEqual({
			Mango: 'produce',
			// Not known by name: its section's "Obst" names „Obst & Gemüse“.
			'Paprika, rot': 'produce',
			// The head noun, as the add bar would place it.
			'Gelbe currypaste': 'pantry',
			Brot: 'bakery',
			// Known by name, so its section ("Brotaufstrich", no aisle here) is not asked.
			Ahornsirup: 'breakfast',
			Chiasamen: 'breakfast',
			Sonnenblumenkerne: 'breakfast',
			Erbsenmilch: 'dairy_eggs'
		});
		expect(rows.every((r) => r.status === 'new' && isSelected(r, undefined))).toBe(true);
	});

	it('places by the name without its amount, and keeps the amount for the row', () => {
		const target = newListTarget();
		const rows = planImport(parseTextList('1 kg Kartoffeln\nMilch (2 Liter)').entries, target);
		expect(rows.map((r) => [r.name, r.quantity, r.categoryKey])).toEqual([
			['Kartoffeln', '1 kg', 'produce'],
			['Milch', '2 Liter', 'dairy_eggs']
		]);
		expect(backupFromPlan('L', rows, templates).items.map((i) => i.quantity)).toEqual([
			'1 kg',
			'2 Liter'
		]);
	});

	it("applies the review's edits by row: a renamed row is checked under its new name", () => {
		const onList = makeItem({ list: 'L', name: 'Milch', category_key: 'cat_dairy_eggs' });
		const entries = parseTextList('Hafermilch\nXyzzy').entries;
		const edits = new Map([
			['0', { name: 'Milch' }],
			['1', { quantity: '2', note: 'die grünen', aisle: { slug: 'produce' } }]
		]);
		const rows = planImport(entries, existingTarget([onList]), edits);
		expect(rows.map((r) => [r.key, r.name, r.status, r.quantity, r.note, r.categoryKey])).toEqual([
			['0', 'Milch', 'on_list', '', null, 'cat_dairy_eggs'],
			['1', 'Xyzzy', 'new', '2', 'die grünen', 'cat_produce']
		]);
	});

	// [D-254] A chosen aisle is kept by what it is, so it lands in the same
	// aisle on whichever target the review is switched to.
	it('carries a chosen aisle to another target, by slug or by a member aisle name', () => {
		const entries = parseTextList('Mango\nKohle').entries;
		const edits = new Map([
			['0', { aisle: { slug: 'bakery' } }],
			// Matched as the aisle form matches names (categoryNameKey).
			['1', { aisle: { name: 'grill  zeug' } }]
		]);
		const grill = makeCategory({ list: 'L', id: 'cat_grill', slug: null, name: 'Grill Zeug ' });
		const existing = existingTarget();
		existing.categories.push(grill);

		const keys = (target: PlanTarget) =>
			planImport(entries, target, edits).map((r) => r.categoryKey);
		expect(keys(existing)).toEqual(['cat_bakery', 'cat_grill']);
		// A new list has the seeded aisles and no member's: Kohle falls back to
		// the plan's own guess, as if nothing had been chosen.
		const guessed = planImport(entries, newListTarget())[1].categoryKey;
		expect(keys(newListTarget())).toEqual(['bakery', guessed]);
	});

	it('names a chosen aisle by slug, a member aisle by name, Others as null', () => {
		const member = makeCategory({ list: 'L', id: 'm1', slug: null, name: 'Grillzeug' });
		const categories = [...existingTarget().categories, member];
		expect(aisleChoice('cat_produce', categories)).toEqual({ slug: 'produce' });
		expect(aisleChoice('m1', categories)).toEqual({ name: 'Grillzeug' });
		expect(aisleChoice(null, categories)).toBeNull();
		expect(aisleChoice('gone', categories)).toBeUndefined();
	});

	it('falls back to Others when neither the name nor the section says anything', () => {
		const rows = planImport(parseTextList('[Krimskrams]\nXyzzy').entries, newListTarget());
		expect(rows[0].categoryKey).toBeNull();
	});

	it('makes one row of a name the text repeats', () => {
		const rows = planImport(parseTextList('Milch\nmilch\n MILCH').entries, newListTarget());
		expect(rows.map((r) => r.name)).toEqual(['Milch']);
	});

	it('leaves an item ticked in the source unselected', () => {
		const rows = planImport(parseTextList('Liste\n☐ Milch\n☑ Brot').entries, newListTarget());
		expect(rows.map((r) => [r.name, isSelected(r, undefined), r.ticked])).toEqual([
			['Milch', true, false],
			['Brot', false, true]
		]);
	});

	it('marks what the list already has, and brings back what it has bought', () => {
		const onList = makeItem({ list: 'L', name: 'Milch', category_key: 'cat_dairy_eggs' });
		const checked = makeItem({
			list: 'L',
			name: 'Brot',
			checked: true,
			category_key: 'cat_bakery'
		});
		const remembered = makeItem({
			list: 'L',
			name: 'Eier',
			deleted_at: '2026-01-01T00:00:00.000Z',
			last_bought_at: '2026-01-01T00:00:00.000Z',
			category_key: 'cat_dairy_eggs'
		});
		const rows = planImport(
			parseTextList('Milch\nBrot\nEier\nKäse').entries,
			existingTarget([onList, checked, remembered])
		);
		expect(rows.map((r) => [r.name, r.status, isSelected(r, undefined), r.existing?.id])).toEqual([
			['Milch', 'on_list', false, undefined],
			['Brot', 'reactivate', true, checked.id],
			['Eier', 'reactivate', true, remembered.id],
			['Käse', 'new', true, undefined]
		]);
		expect(rows[3].categoryKey).toBe('cat_dairy_eggs');
	});

	it('refuses a name longer than an item may be', () => {
		const rows = planImport(
			[{ name: 'x'.repeat(5000), quantity: '', section: null, checked: false }],
			newListTarget()
		);
		expect(rows[0]).toMatchObject({ status: 'too_long' });
		expect(isSelected(rows[0], undefined)).toBe(false);
	});
});

describe('groupRows', () => {
	it('orders the aisles as the list walks them, Others last', () => {
		const target = newListTarget();
		const rows = planImport(parseTextList('Xyzzy\nMilch\nMango').entries, target);
		const groups = groupRows(rows, target.categories, target.templates);
		expect(groups.map((g) => [g.category.slug, g.rows.map((r) => r.name)])).toEqual([
			['produce', ['Mango']],
			['dairy_eggs', ['Milch']],
			['other', ['Xyzzy']]
		]);
	});
});

describe('backupFromPlan', () => {
	it('is a backup the import route accepts: the roster, and the chosen new rows', () => {
		const target = newListTarget();
		const rows = planImport(parseTextList('Liste\n☐ Milch\n☑ Brot').entries, target);
		const chosen = rows.filter((r) => isSelected(r, undefined));
		const backup = backupFromPlan('Hamburg', chosen, templates);

		const parsed = parseListBackup(JSON.parse(JSON.stringify(backup)));
		expect(parsed.ok).toBe(true);
		expect(backup.display_name).toBe('Hamburg');
		expect(backup.categories.map((c) => c.slug)).toEqual(
			templates
				.filter((t) => !t.retired)
				.sort((a, b) => a.sort_order - b.sort_order)
				.map((t) => t.slug)
		);
		expect(backup.categories.every((c) => c.name === null)).toBe(true);
		expect(backup.items).toHaveLength(1);
		const milk = backup.items[0];
		expect(milk.name).toBe('Milch');
		expect(backup.categories.find((c) => c.key === milk.category_key)?.slug).toBe('dairy_eggs');
	});
});

// The review's reading of a row: what it offers, what it says under it, the
// item the list view's components render, and an edit folded from the sheet.
describe('the review of a row', () => {
	const row = (overrides: Partial<PlanRow>): PlanRow => ({
		key: '3',
		name: 'Milch',
		quantity: '1 l',
		note: null,
		categoryKey: 'cat_dairy_eggs',
		status: 'new',
		ticked: false,
		...overrides
	});

	it('offers only what it would create or bring back, ticked by the review over the plan', () => {
		expect(selectable(row({ status: 'new' }))).toBe(true);
		expect(selectable(row({ status: 'reactivate' }))).toBe(true);
		expect(selectable(row({ status: 'on_list' }))).toBe(false);
		expect(selectable(row({ status: 'too_long' }))).toBe(false);
		expect(isSelected(row({ ticked: true }), undefined)).toBe(false);
		expect(isSelected(row({ ticked: true }), { selected: true })).toBe(true);
		expect(isSelected(row({}), { selected: false })).toBe(false);
		expect(isSelected(row({ status: 'on_list' }), { selected: true })).toBe(false);
	});

	it('says why a row is not offered, or why it starts unticked', () => {
		expect(statusNote(row({ status: 'on_list' }))).toBe(message('import_status_on_list'));
		expect(statusNote(row({ status: 'too_long' }))).toBe(message('import_status_too_long'));
		expect(statusNote(row({ status: 'reactivate' }))).toBe(message('import_status_reactivate'));
		expect(statusNote(row({ ticked: true }))).toBe(message('import_status_ticked'));
		expect(statusNote(row({}))).toBeNull();
	});

	it("renders as an unchecked item on the target, with the row's fields", () => {
		const item = rowAsItem(row({ note: 'fettarm' }), 'L');
		expect(item).toMatchObject({
			id: 'import-3',
			list: 'L',
			name: 'Milch',
			quantity: '1 l',
			note: 'fettarm',
			category_key: 'cat_dairy_eggs',
			checked: false,
			deleted_at: null
		});
	});

	it('folds an edit in, keeping the aisle by what it is', () => {
		const categories = existingTarget().categories;
		expect(withPatch(undefined, { quantity: '2' }, categories)).toEqual({ quantity: '2' });
		expect(
			withPatch({ quantity: '2' }, { name: 'Hafermilch', category_key: 'cat_bakery' }, categories)
		).toEqual({ quantity: '2', name: 'Hafermilch', aisle: { slug: 'bakery' } });
		expect(withPatch({}, { note: null, category_key: null }, categories)).toEqual({
			note: null,
			aisle: null
		});
		// An aisle the target does not have leaves the edit's as it was.
		expect(withPatch({ aisle: { slug: 'bakery' } }, { category_key: 'gone' }, categories)).toEqual({
			aisle: { slug: 'bakery' }
		});
	});
});
