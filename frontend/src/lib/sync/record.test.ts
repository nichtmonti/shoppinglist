import { describe, it, expect } from 'vitest';
import { normalizeItem, normalizeCategory, normalizeRecord } from './record';

describe('record.ts', () => {
	describe('normalizeItem', () => {
		it('coerces a PB-shaped record (list as ["<id>"], modified_by as string, note null, checked true as boolean, a date string) to the exact Item shape', () => {
			const pbRecord = {
				id: 'item-1',
				list: ['list-1'],
				name: 'Milk',
				quantity: '2',
				note: null,
				category_key: 'dairy',
				checked: true,
				checked_at: '2024-01-15T10:30:00.000Z',
				last_bought_at: '2024-01-10T09:00:00.000Z',
				barcode: '1234567890123',
				image_url: 'https://example.com/milk.jpg',
				modified_by: 'user-1',
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const result = normalizeItem(pbRecord);
			expect(result).toEqual({
				id: 'item-1',
				list: 'list-1',
				name: 'Milk',
				name_de: null,
				name_en: null,
				quantity: '2',
				note: null,
				category_key: 'dairy',
				checked: true,
				checked_at: '2024-01-15T10:30:00.000Z',
				last_bought_at: '2024-01-10T09:00:00.000Z',
				barcode: '1234567890123',
				image_url: 'https://example.com/milk.jpg',
				modified_by: 'user-1',
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			});
		});

		it('handles list as a plain string too (not array)', () => {
			const pbRecord = {
				id: 'item-2',
				list: 'list-2',
				name: 'Bread',
				quantity: '1',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const result = normalizeItem(pbRecord);
			expect(result.list).toBe('list-2');
			expect(result.modified_by).toBeNull();
		});
	});

	describe('normalizeCategory', () => {
		it('coerces slug/name nullable + sort_order number', () => {
			const pbRecord = {
				id: 'cat-1',
				list: 'list-1',
				slug: 'dairy',
				name: 'Dairy',
				icon: '🥛',
				color: '#ffffff',
				sort_order: 1,
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const result = normalizeCategory(pbRecord);
			expect(result).toEqual({
				id: 'cat-1',
				list: 'list-1',
				slug: 'dairy',
				name: 'Dairy',
				icon: '🥛',
				color: '#ffffff',
				sort_order: 1,
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			});
		});

		it('handles null/undefined slug/name and string sort_order', () => {
			const pbRecord = {
				id: 'cat-2',
				list: ['list-2'],
				slug: null,
				name: null,
				icon: '🍞',
				color: '#ffff00',
				sort_order: '5',
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const result = normalizeCategory(pbRecord);
			expect(result.slug).toBeNull();
			expect(result.name).toBeNull();
			expect(result.sort_order).toBe(5);
			expect(result.list).toBe('list-2');
		});
	});

	describe('normalizeRecord', () => {
		it('dispatches to normalizeItem for items', () => {
			const pbRecord = {
				id: 'item-1',
				list: ['list-1'],
				name: 'Milk',
				quantity: '2',
				note: null,
				category_key: null,
				checked: false,
				checked_at: null,
				last_bought_at: null,
				barcode: null,
				image_url: null,
				modified_by: null,
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const result = normalizeRecord('items', pbRecord);
			expect(result).toHaveProperty('id', 'item-1');
			expect(result).toHaveProperty('name', 'Milk');
		});

		it('dispatches to normalizeCategory for list_categories', () => {
			const pbRecord = {
				id: 'cat-1',
				list: 'list-1',
				slug: 'dairy',
				name: 'Dairy',
				icon: '🥛',
				color: '#ffffff',
				sort_order: 1,
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const result = normalizeRecord('list_categories', pbRecord);
			expect(result).toHaveProperty('id', 'cat-1');
			expect(result).toHaveProperty('slug', 'dairy');
		});

		// The push settle (push.ts settleRecord) normalizes before its shadow
		// put, exactly like the inbound paths (apply.ts applyServerRows) — so
		// it can receive rows that are ALREADY canonical. Normalizing twice must
		// be a no-op, or the paths would disagree about the stored shape.
		it('is idempotent for its own output (items)', () => {
			const wire = {
				id: 'item-1',
				list: ['list-1'], // expanded relation array → single id
				name: 'Milk',
				quantity: 2, // number → string
				note: '', // empty string → null
				category_key: null,
				checked: 1, // truthy number → boolean
				checked_at: null,
				last_bought_at: null,
				barcode: null,
				image_url: null,
				modified_by: ['acc-1'],
				updated: 1710000000000, // epoch millis → string
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const once = normalizeRecord('items', wire);
			// The first pass really coerced (idempotency is not vacuous)…
			expect(once).toMatchObject({
				list: 'list-1',
				quantity: '2',
				note: null,
				checked: true,
				modified_by: 'acc-1',
				updated: '1710000000000'
			});
			// …and the second pass is a no-op.
			const twice = normalizeRecord('items', once as unknown as Record<string, unknown>);
			expect(twice).toEqual(once);
		});

		it('is idempotent for its own output (list_categories)', () => {
			const wire = {
				id: 'cat-1',
				list: 'list-1',
				slug: '', // empty string → null
				name: undefined, // absent → null
				icon: undefined, // absent → ''
				color: '#ffffff',
				sort_order: '5', // string → number
				updated: '2024-01-15T10:30:00.000Z',
				created: '2024-01-01T00:00:00.000Z',
				deleted_at: null
			};
			const once = normalizeRecord('list_categories', wire);
			expect(once).toMatchObject({ slug: null, name: null, icon: '', sort_order: 5 });
			const twice = normalizeRecord('list_categories', once as unknown as Record<string, unknown>);
			expect(twice).toEqual(once);
		});
	});
});
