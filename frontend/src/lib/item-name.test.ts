// [D-21]: a scanned item shows each viewer its name in their UI language and
// answers to every one of its names; a typed item is just its name.
import { describe, expect, it } from 'vitest';

import { findByName, nameTakenBy } from './dedup';
import { displayName, hasLocalizedNames, nameKeys } from './item-name';
import { makeItem } from './test-kit/db';

const scanned = makeItem({
	list: 'list-1',
	name: 'Pâte à tartiner',
	name_de: 'Nuss-Nougat-Creme',
	name_en: 'Hazelnut spread'
});

describe('displayName', () => {
	it("shows the viewer's language", () => {
		expect(displayName(scanned, 'de')).toBe('Nuss-Nougat-Creme');
		expect(displayName(scanned, 'en')).toBe('Hazelnut spread');
	});

	it('falls back to the name when the product has none in that language', () => {
		expect(displayName({ ...scanned, name_en: null }, 'en')).toBe('Pâte à tartiner');
	});

	it('reads a row stored before the columns existed as its name', () => {
		expect(displayName({ name: 'Milch' }, 'de')).toBe('Milch');
	});
});

describe('nameKeys', () => {
	it('is every normalized name, name first, without repeats', () => {
		expect(nameKeys(scanned)).toEqual(['pâte à tartiner', 'nuss-nougat-creme', 'hazelnut spread']);
		expect(nameKeys({ name: 'Milch', name_de: 'milch ', name_en: null })).toEqual(['milch']);
	});
});

describe('hasLocalizedNames', () => {
	it('is true only for an item carrying a localized name', () => {
		expect(hasLocalizedNames(scanned)).toBe(true);
		expect(hasLocalizedNames(makeItem({ list: 'list-1', name: 'Milch' }))).toBe(false);
	});
});

// The "already on the list" jump: a member who SEES the German name and types
// it must land on the scanned row, not add a second one.
describe('findByName on a scanned row', () => {
	it('matches any of its names', () => {
		for (const typed of ['Nuss-Nougat-Creme', 'hazelnut spread', 'Pâte à tartiner']) {
			expect(findByName([scanned], typed)?.id).toBe(scanned.id);
		}
		expect(findByName([scanned], 'Nutella')).toBeUndefined();
	});
});

describe("nameTakenBy, a rename into another row's name", () => {
	it('is taken by any name of another row, never by the row itself', () => {
		expect(nameTakenBy([scanned], 'hazelnut spread', 'other-id')).toBe(true);
		expect(nameTakenBy([scanned], 'Nuss-Nougat-Creme', scanned.id)).toBe(false);
		expect(nameTakenBy([scanned], 'Nutella', 'other-id')).toBe(false);
	});
});
