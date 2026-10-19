import { describe, expect, it } from 'vitest';

import type { Item } from '#lib/db.js';
import { makeItem } from '#lib/test-kit/db.js';
import { showsDoor, tileModel } from './tile-model';

const item = (o: Partial<Item>) => makeItem({ list: 'l1', name: 'Milch', ...o });

describe('tileModel', () => {
	it('a typed item is a typed tile with no media and a door only while cut', () => {
		const m = tileModel(item({ quantity: '2 l', note: 'fettarm' }));
		expect(m).toMatchObject({ kind: 'typed', media: 'none', quantity: '2 l', note: 'fettarm' });
		expect(showsDoor(m, false)).toBe(false);
		expect(showsDoor(m, true)).toBe(true);
	});

	it('a scanned item is a product tile with its photo, and its barcode earns the door', () => {
		const m = tileModel(item({ barcode: '4000000000001', image_url: 'https://x/p.jpg' }));
		expect(m).toMatchObject({ kind: 'product', media: 'photo' });
		// The barcode's number is only in the sheet, so the door shows even
		// when every piece of text fits ([D-83]).
		expect(showsDoor(m, false)).toBe(true);
	});

	it('the door follows what the tile hides, not what kind of tile it is ([D-83])', () => {
		// A photo is shown ON the tile: without a barcode or cut text there is
		// nothing for the door to reveal, product layout or not.
		const photoOnly = tileModel(item({ image_url: 'https://x/p.jpg' }));
		expect(photoOnly.kind).toBe('product');
		expect(showsDoor(photoOnly, false)).toBe(false);
		expect(showsDoor(photoOnly, true)).toBe(true);
		// A barcode without a photo still hides its number.
		expect(showsDoor(tileModel(item({ barcode: '4000000000001' })), false)).toBe(true);
	});

	it('a product whose photo failed or is missing keeps the product layout on the placeholder', () => {
		const failed = item({ barcode: '4000000000001', image_url: 'https://x/p.jpg' });
		expect(tileModel(failed, { photoFailed: true })).toMatchObject({
			kind: 'product',
			media: 'placeholder'
		});
		expect(tileModel(item({ barcode: '4000000000001' }))).toMatchObject({
			kind: 'product',
			media: 'placeholder'
		});
	});

	it('a row shows the photo as a thumbnail, and the door leads to it ([D-313], [D-331])', () => {
		const photoOnly = tileModel(item({ image_url: 'https://x/p.jpg' }), { row: true });
		expect(photoOnly).toMatchObject({ kind: 'product', media: 'thumb' });
		expect(showsDoor(photoOnly, false)).toBe(true);
		// A failed photo leaves the icon; the door still leads to the sheet.
		const failed = tileModel(item({ image_url: 'https://x/p.jpg' }), {
			row: true,
			photoFailed: true
		});
		expect(failed.media).toBe('none');
		expect(showsDoor(failed, false)).toBe(true);
		// No placeholder either: a row with nothing to show shows nothing.
		expect(tileModel(item({ barcode: '4000000000001' }), { row: true }).media).toBe('none');
		expect(showsDoor(tileModel(item({}), { row: true }), false)).toBe(false);
	});

	it('an absent note reads as empty', () => {
		expect(tileModel(item({})).note).toBe('');
	});
});
