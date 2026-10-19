// §6.7 [D-37] what the category form's Save writes for an edit.
import { describe, expect, it } from 'vitest';
import { categoryEditFields, type CategoryDrafts } from './category-form';

const opened: CategoryDrafts = { name: 'Grillzeug', icon: '🔥', color: 'red' };
const memberRow = { name: 'Grillzeug', slug: null };
const seededRow = { name: 'Obst', slug: 'produce' };

describe('categoryEditFields', () => {
	it('writes nothing the drafts left as opened, spacing aside', () => {
		expect(categoryEditFields({ ...opened, name: ' Grillzeug ' }, opened, memberRow)).toEqual({});
	});

	it('writes only the fields that changed', () => {
		expect(categoryEditFields({ ...opened, color: 'blue' }, opened, memberRow)).toEqual({
			color: 'blue'
		});
		expect(
			categoryEditFields({ name: ' Grill ', icon: '🍖', color: 'red' }, opened, memberRow)
		).toEqual({ name: 'Grill', icon: '🍖' });
	});

	it("resets a blanked seeded name to the template's, and keeps a member row's", () => {
		const seeded = { ...opened, name: 'Obst' };
		expect(categoryEditFields({ ...seeded, name: '  ' }, seeded, seededRow)).toEqual({
			name: null
		});
		expect(categoryEditFields({ ...opened, name: '' }, opened, memberRow)).toEqual({
			name: 'Grillzeug'
		});
	});
});
