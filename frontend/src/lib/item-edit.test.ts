import { describe, expect, it } from 'vitest';
import { itemDrafts, itemEditPatch } from './item-edit';
import { makeCategory, makeItem } from './test-kit/db';

const LIST = 'list-1';
const dairy = makeCategory({ list: LIST, slug: 'dairy_eggs' });
const others = makeCategory({ list: LIST, slug: 'other' });
const categories = [dairy, others];

describe('itemEditPatch', () => {
	const milk = makeItem({
		list: LIST,
		name: 'Milch',
		quantity: '1 l',
		note: 'bio',
		category_key: dairy.id
	});

	it('is empty for the drafts the sheet opened with', () => {
		expect(itemEditPatch(milk, itemDrafts(milk, categories), categories)).toEqual({});
	});

	it('carries only the fields that changed, trimmed', () => {
		const drafts = { ...itemDrafts(milk, categories), name: ' Hafermilch ', quantity: '2 l ' };
		expect(itemEditPatch(milk, drafts, categories)).toEqual({
			name: 'Hafermilch',
			quantity: '2 l'
		});
	});

	it('keeps the name when the draft is emptied, and clears an emptied note', () => {
		const drafts = { ...itemDrafts(milk, categories), name: '  ', note: ' ' };
		expect(itemEditPatch(milk, drafts, categories)).toEqual({ note: null });
	});

	it('moves the item to the chosen category', () => {
		const drafts = { ...itemDrafts(milk, categories), category: others.id };
		expect(itemEditPatch(milk, drafts, categories)).toEqual({ category_key: others.id });
	});

	it('compares against the shown name, so an untouched scanned item is not renamed ([D-21])', () => {
		const scanned = makeItem({ list: LIST, name: 'Milk 1L', name_de: 'Milch', name_en: 'Milk' });
		expect(itemEditPatch(scanned, itemDrafts(scanned, categories), categories)).toEqual({});
	});

	// A co-member's edit lands while the sheet is open: the row moves, the
	// drafts do not, and closing must not send the old values back (§8.4).
	it('sends nothing a co-member changed while the sheet was open', () => {
		const opened = itemDrafts(milk, categories);
		const theirs = { ...milk, quantity: '2 l', note: null, category_key: others.id };
		expect(itemEditPatch(theirs, opened, categories, opened)).toEqual({});
		const mine = { ...opened, name: 'Hafermilch' };
		expect(itemEditPatch(theirs, mine, categories, opened)).toEqual({ name: 'Hafermilch' });
	});

	it('reads an uncategorised item as Others, so leaving it there changes nothing', () => {
		const loose = makeItem({ list: LIST, name: 'Kerzen', category_key: null });
		expect(itemDrafts(loose, categories).category).toBe(others.id);
		expect(itemEditPatch(loose, itemDrafts(loose, categories), categories)).toEqual({});
	});
});
