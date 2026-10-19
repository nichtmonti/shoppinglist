// The category color rendering (header + badge tint, Others gray).
// The rendering rule is one function — `categoryStyle` — so the header, the row
// chip, the typeahead avatar and the editor all tint from the same value; this
// pins the mapping and the fallbacks.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	PALETTE,
	categoryColorVar,
	categoryName,
	categoryOf,
	categoryStyle,
	isPaletteToken,
	othersCategory,
	sortCategories,
	templateMap,
	templateDefaultName,
	editedCategoryName,
	missingTemplates,
	nextSortOrder
} from './categories';
import { CONTRACT_PALETTE } from './field-contract';
import { makeCategory, makeItem, makeTemplate } from './test-kit/db';
import { setLocale } from './i18n';
import { seedTemplates } from './test-kit/seed';

const LIST = 'list-1';

describe('the curated palette [D-37]', () => {
	it('covers every color the seed assigns', () => {
		// A token the seed uses but the frontend does not map would render as an
		// undefined custom property (i.e. no color).
		for (const { slug, color } of seedTemplates) expect(isPaletteToken(color), slug).toBe(true);
	});

	it('maps a token to its CSS custom property', () => {
		expect(categoryColorVar('green')).toBe('var(--cat-green)');
		expect(categoryStyle('sky')).toBe('--c: var(--cat-sky)');
	});

	it('falls back to gray for an unknown or missing token', () => {
		// Free hex colors were rejected outright [D-37]; anything off-palette must
		// degrade to the neutral rather than emit a broken var().
		expect(categoryColorVar('#ff0000')).toBe('var(--cat-gray)');
		expect(categoryColorVar(null)).toBe('var(--cat-gray)');
	});

	it('renders Others gray, as the seed assigns it', () => {
		const others = makeCategory({ list: LIST, slug: 'other', name: null, color: 'gray' });
		expect(categoryStyle(others.color)).toBe('--c: var(--cat-gray)');
	});

	it('matches the shared contract palette, in the same curated order', () => {
		// CONTRACT_PALETTE comes from the shared field-contract.json; PALETTE is
		// the literal `as const` array that gives PaletteToken its union. Both
		// carry the same curated order [D-37], so the comparison is order-sensitive.
		expect([...CONTRACT_PALETTE]).toEqual([...PALETTE]);
	});

	it('every palette token has a --cat-<token> declaration in both themes', () => {
		// An unknown/renamed token renders gray with no error anywhere in the
		// stack: categoryColorVar falls back to --cat-gray, and a missing custom
		// property is just undefined. This pins the app.css declarations to the
		// palette so a dropped token fails CI instead of silently graying out.
		const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
		for (const theme of ['light', 'dark'] as const) {
			const start = theme === 'light' ? css.indexOf(':root {') : css.indexOf('.dark {');
			const end = css.indexOf('}', start);
			const block = css.slice(start, end);
			for (const token of PALETTE) {
				expect(block, `${theme}: --cat-${token} missing from app.css`).toContain(`--cat-${token}:`);
			}
		}
	});
});

describe('category names (§6.7)', () => {
	const templates = templateMap([
		makeTemplate({ slug: 'other', name_i18n: { de: 'Sonstiges', en: 'Other' } }),
		makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse', en: 'Produce' } })
	]);

	it('renders the localized template default while name is null', () => {
		setLocale('de');
		const row = makeCategory({ list: LIST, slug: 'produce', name: null });
		expect(categoryName(row, templates)).toBe('Obst & Gemüse');

		setLocale('en');
		expect(categoryName(row, templates)).toBe('Produce');
		setLocale('de');
	});

	it('prefers a set name over the template default', () => {
		const row = makeCategory({ list: LIST, slug: 'produce', name: 'Marktstand' });
		expect(categoryName(row, templates)).toBe('Marktstand');
	});

	it('falls back to the slug when no template is mirrored yet', () => {
		const row = makeCategory({ list: LIST, slug: 'unknown_slug', name: null });
		expect(categoryName(row, templateMap([]))).toBe('unknown_slug');
	});
});

describe('editing a category (§6.7)', () => {
	const templates = templateMap([
		makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse', en: 'Produce' } })
	]);

	it("offers a seeded row's template name as its default, even once renamed", () => {
		setLocale('de');
		const renamed = makeCategory({ list: LIST, slug: 'produce', name: 'Marktstand' });
		expect(templateDefaultName(renamed, templates)).toBe('Obst & Gemüse');
	});

	it('has no default for a member-added row or an unknown template', () => {
		expect(templateDefaultName({ slug: null }, templates)).toBe('');
		expect(templateDefaultName({ slug: 'unknown_slug' }, templates)).toBe('');
	});

	it('saves a trimmed draft name', () => {
		expect(editedCategoryName('  Markt  ', { slug: 'produce', name: null })).toBe('Markt');
	});

	it('resets a seeded row to its template default when the draft is blank', () => {
		expect(editedCategoryName('   ', { slug: 'produce', name: 'Marktstand' })).toBeNull();
	});

	it('keeps a member-added row’s name when the draft is blank', () => {
		expect(editedCategoryName('', { slug: null, name: 'Drogerie' })).toBe('Drogerie');
	});

	it('places a new category after every row, hidden ones included', () => {
		expect(nextSortOrder([{ sort_order: 3 }, { sort_order: 17 }])).toBe(18);
		expect(nextSortOrder([])).toBe(1);
	});
});

describe('ordering and fallback (§6.6, [D-30])', () => {
	const templates = templateMap([makeTemplate({ slug: 'other' })]);

	it('sorts Others last however its sort_order is set', () => {
		const others = makeCategory({ list: LIST, slug: 'other', name: null, sort_order: 1 });
		const produce = makeCategory({ list: LIST, slug: 'produce', name: 'Obst', sort_order: 5 });
		const dairy = makeCategory({ list: LIST, slug: 'dairy_eggs', name: 'Milch', sort_order: 9 });

		expect(sortCategories([others, dairy, produce], templates).map((c) => c.slug)).toEqual([
			'produce',
			'dairy_eggs',
			'other'
		]);
	});

	it('never returns a hidden row as an item category', () => {
		const hidden = makeCategory({
			list: LIST,
			name: 'Weg',
			deleted_at: new Date().toISOString()
		});
		const others = makeCategory({ list: LIST, slug: 'other', name: null });
		const item = makeItem({ list: LIST, name: 'Kerzen', category_key: hidden.id });

		expect(categoryOf(item, [hidden, others])?.id).toBe(others.id);
	});

	it('finds the Others row by slug, ignoring its name', () => {
		const renamed = makeCategory({ list: LIST, slug: 'other', name: 'Kramkiste' });
		expect(othersCategory([renamed])?.id).toBe(renamed.id);
	});
});

describe('the templates a list lacks [D-251]', () => {
	it('offers the current ones in walk order, never a retired one [D-300]', () => {
		const templates = [
			makeTemplate({ slug: 'car_bike', sort_order: 20 }),
			makeTemplate({ slug: 'garden', sort_order: 22, retired: true }),
			makeTemplate({ slug: 'coffee_tea', sort_order: 9 }),
			makeTemplate({ slug: 'produce', sort_order: 1 })
		];
		const have = [makeCategory({ list: LIST, slug: 'produce' })];
		expect(missingTemplates(templates, have).map((t) => t.slug)).toEqual([
			'coffee_tea',
			'car_bike'
		]);
	});
});
