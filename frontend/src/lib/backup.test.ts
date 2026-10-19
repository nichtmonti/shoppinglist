// [D-72] per-list backup documents: parse, filename.
import { describe, it, expect } from 'vitest';
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	MAX_BACKUP_CATEGORIES,
	MAX_BACKUP_ITEMS,
	parseListBackup,
	backupFileName
} from './backup';
import { IMPORT_MAX_ITEMS } from './config';

describe('parseListBackup', () => {
	it('rejects non-object input and a wrong format', () => {
		expect(parseListBackup(null)).toEqual({ ok: false, reason: 'format' });
		expect(parseListBackup('nope')).toEqual({ ok: false, reason: 'format' });
		expect(
			parseListBackup({
				format: 'other/format',
				version: BACKUP_VERSION,
				exported_at: '',
				display_name: '',
				categories: [],
				items: []
			})
		).toEqual({ ok: false, reason: 'format' });
	});

	it('rejects a wrong version', () => {
		expect(
			parseListBackup({
				format: BACKUP_FORMAT,
				version: BACKUP_VERSION + 1,
				exported_at: '',
				display_name: '',
				categories: [],
				items: []
			})
		).toEqual({ ok: false, reason: 'version' });
	});

	it('rejects items referencing an unknown category key', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [{ key: 'c0', slug: null, name: null, icon: '🛒', color: 'gray', sort_order: 1 }],
			items: [
				{
					name: 'Brot',
					quantity: '1',
					note: null,
					category_key: 'c9',
					barcode: null,
					image_url: null
				}
			]
		};
		expect(parseListBackup(data)).toEqual({ ok: false, reason: 'dangling_category' });
	});

	it('rejects more than MAX_BACKUP_CATEGORIES categories', () => {
		const categories = Array.from({ length: MAX_BACKUP_CATEGORIES + 1 }, (_, i) => ({
			key: `c${i}`,
			slug: null,
			name: null,
			icon: '🛒',
			color: 'gray',
			sort_order: i
		}));
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '',
			display_name: '',
			categories,
			items: []
		};
		expect(parseListBackup(data)).toEqual({ ok: false, reason: 'too_many_categories' });
	});

	it('rejects more than MAX_BACKUP_ITEMS items', () => {
		const items = Array.from({ length: MAX_BACKUP_ITEMS + 1 }, (_, i) => ({
			name: `item-${i}`,
			quantity: '',
			note: null,
			category_key: null,
			barcode: null,
			image_url: null
		}));
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '',
			display_name: '',
			categories: [],
			items
		};
		expect(parseListBackup(data)).toEqual({
			ok: false,
			reason: 'too_many_items',
			max: MAX_BACKUP_ITEMS,
			count: MAX_BACKUP_ITEMS + 1
		});
	});

	it("checks against the instance's lowered cap when given one ([D-217])", () => {
		const item = (i: number) => ({
			name: `item-${i}`,
			quantity: '',
			note: null,
			category_key: null,
			barcode: null,
			image_url: null
		});
		const data = (n: number) => ({
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '',
			display_name: '',
			categories: [],
			items: Array.from({ length: n }, (_, i) => item(i))
		});
		expect(parseListBackup(data(3), 3).ok).toBe(true);
		expect(parseListBackup(data(4), 3)).toEqual({
			ok: false,
			reason: 'too_many_items',
			max: 3,
			count: 4
		});
	});

	it('an unstamped instance imports up to the backup cap', () => {
		expect(IMPORT_MAX_ITEMS).toBe(MAX_BACKUP_ITEMS);
	});

	it('rejects an item whose name exceeds the byte cap', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '',
			display_name: '',
			categories: [],
			items: [
				{
					name: 'x'.repeat(10_000),
					quantity: '',
					note: null,
					category_key: null,
					barcode: null,
					image_url: null
				}
			]
		};
		expect(parseListBackup(data)).toEqual({ ok: false, reason: 'oversize' });
	});

	it('rejects a category whose name exceeds the byte cap', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '',
			display_name: '',
			categories: [
				{
					key: 'c0',
					slug: null,
					name: 'y'.repeat(10_000),
					icon: '🛒',
					color: 'gray',
					sort_order: 1
				}
			],
			items: []
		};
		expect(parseListBackup(data)).toEqual({ ok: false, reason: 'oversize' });
	});

	it('drops unknown/extra fields when rebuilding (stateless drop)', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [
				{
					key: 'c0',
					slug: null,
					name: null,
					icon: '🛒',
					color: 'gray',
					sort_order: 1,
					extra: 'x'
				}
			],
			items: [
				{
					name: 'Brot',
					quantity: '1',
					note: null,
					category_key: null,
					barcode: null,
					image_url: null,
					checked: true,
					checked_at: '2026-08-29T00:00:00.000Z',
					modified_by: 'acc-1',
					id: 'item-1',
					updated: '2026-08-29T00:00:00.000Z',
					created: '2026-08-29T00:00:00.000Z',
					deleted_at: null
				}
			]
		};

		const result = parseListBackup(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.items[0]).toEqual({
				name: 'Brot',
				quantity: '1',
				note: null,
				category_key: null,
				barcode: null,
				image_url: null,
				checked: true,
				checked_at: '2026-08-29T00:00:00.000Z'
			});
			expect(result.value.categories[0]).toEqual({
				key: 'c0',
				slug: null,
				name: null,
				icon: '🛒',
				color: 'gray',
				sort_order: 1
			});
			// The state fields are known and carried; the sync-owned columns
			// are still dropped.
			expect('checked' in result.value.items[0]).toBe(true);
			expect('checked_at' in result.value.items[0]).toBe(true);
			expect('last_bought_at' in result.value.items[0]).toBe(false);
			expect('id' in result.value.items[0]).toBe(false);
		}
	});

	it('normalizes an absent `checked` to false, as the import route does', () => {
		// The Go side reads `checked` as *bool and treats nil as false
		// (backend/internal/lists/import.go). If this side REJECTED such a file
		// instead, a document one half accepts would be one the other refuses —
		// the drift class the shared field contract exists to prevent.
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [],
			items: [
				{
					name: 'Brot',
					quantity: '1',
					note: null,
					category_key: null,
					barcode: null,
					image_url: null
				}
			]
		};

		const result = parseListBackup(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.items[0].checked).toBe(false);
			expect('checked_at' in result.value.items[0]).toBe(false);
			expect('last_bought_at' in result.value.items[0]).toBe(false);
		}
	});

	// [D-21]: a scanned item's localized names round-trip; they are optional,
	// so every document above (none carries them) parses, and a wrong type or
	// an oversized one is refused like any other field.
	it("round-trips a scanned item's localized names, and checks them", () => {
		const doc = (item: Record<string, unknown>) => ({
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [],
			items: [
				{
					name: 'Pâte à tartiner',
					quantity: '',
					note: null,
					category_key: null,
					barcode: '3017620422003',
					image_url: null,
					...item
				}
			]
		});

		const ok = parseListBackup(doc({ name_de: 'Nuss-Nougat-Creme', name_en: 'Hazelnut spread' }));
		expect(ok.ok && ok.value.items[0]).toMatchObject({
			name_de: 'Nuss-Nougat-Creme',
			name_en: 'Hazelnut spread'
		});
		expect(parseListBackup(doc({ name_de: 42 }))).toEqual({ ok: false, reason: 'shape' });
		expect(parseListBackup(doc({ name_en: 'x'.repeat(257) }))).toEqual({
			ok: false,
			reason: 'oversize'
		});
	});

	it('round-trips a document with the checked state intact', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [],
			items: [
				{
					name: 'Brot',
					quantity: '1',
					note: null,
					category_key: null,
					barcode: null,
					image_url: null,
					checked: true,
					checked_at: '2026-08-28T00:00:00.000Z',
					last_bought_at: '2026-08-28T00:00:00.000Z'
				}
			]
		};

		const result = parseListBackup(data);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.items[0]).toEqual({
				name: 'Brot',
				quantity: '1',
				note: null,
				category_key: null,
				barcode: null,
				image_url: null,
				checked: true,
				checked_at: '2026-08-28T00:00:00.000Z',
				last_bought_at: '2026-08-28T00:00:00.000Z'
			});
		}
	});

	it('rejects an item whose checked_at does not parse', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [],
			items: [
				{
					name: 'Brot',
					quantity: '1',
					note: null,
					category_key: null,
					barcode: null,
					image_url: null,
					checked: true,
					checked_at: 'nope'
				}
			]
		};
		expect(parseListBackup(data)).toEqual({ ok: false, reason: 'shape' });
	});

	it('rejects checked_at without checked === true', () => {
		const data = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exported_at: '2026-08-29T00:00:00.000Z',
			display_name: 'Wochenshop',
			categories: [],
			items: [
				{
					name: 'Brot',
					quantity: '1',
					note: null,
					category_key: null,
					barcode: null,
					image_url: null,
					checked_at: '2026-08-28T00:00:00.000Z'
				}
			]
		};
		expect(parseListBackup(data)).toEqual({ ok: false, reason: 'shape' });
	});
});

describe('backupFileName', () => {
	it('folds umlauts, strips emoji, appends the date', () => {
		expect(backupFileName('Wocheneinkauf 🛒', new Date('2026-08-29T12:00:00Z'))).toBe(
			'wocheneinkauf-2026-08-29.json'
		);
	});

	it('folds ä/ö/ü/ß for the filename only', () => {
		expect(backupFileName('Äpfel & Öl für Straße', new Date('2026-08-29T12:00:00Z'))).toBe(
			'aepfel-oel-fuer-strasse-2026-08-29.json'
		);
	});

	it('falls back to liste for an empty result', () => {
		expect(backupFileName('', new Date('2026-08-29T12:00:00Z'))).toBe('liste-2026-08-29.json');
		// Named for the local day: a minute after midnight is today, not yesterday's UTC date.
		expect(backupFileName('Liste', new Date(2026, 9, 14, 0, 1))).toBe('liste-2026-10-14.json');
		expect(backupFileName('🛒🛒', new Date('2026-08-29T12:00:00Z'))).toBe('liste-2026-08-29.json');
	});
});
