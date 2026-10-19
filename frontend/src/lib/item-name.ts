// A scanned item's name in the viewer's language ([D-21]). A scanned row (and
// a demo example item, [D-234]) carries `name_de`/`name_en` beside `name`, which stays the one string the
// server merges on (§8.3 [D-29]); a rename clears both (editItem). Every
// client-side "is it on the list?" check reads nameKeys, not `name`.
import type { Item } from './db';
import { getLocale, type Locale } from './i18n';
import { normalizeName } from './normalize';

type Named = Pick<Item, 'name'> & Partial<Pick<Item, 'name_de' | 'name_en'>>;

/** The name to show this viewer. */
export function displayName(item: Named, locale: Locale = getLocale()): string {
	return (locale === 'de' ? item.name_de : item.name_en) || item.name;
}

/** Every normalized name the item answers to, `name` first, without repeats. */
export function nameKeys(item: Named): string[] {
	const keys = [normalizeName(item.name)];
	for (const alt of [item.name_de, item.name_en]) {
		const key = alt ? normalizeName(alt) : '';
		if (key && !keys.includes(key)) keys.push(key);
	}
	return keys;
}

/** Whether the item carries any localized name — i.e. a rename must clear them. */
export function hasLocalizedNames(item: Named): boolean {
	return Boolean(item.name_de || item.name_en);
}

/** Scan provenance, not picture availability: a scanned item stays scanned
 *  when its photo is missing or fails to load. */
export function isScanned(item: Pick<Item, 'image_url' | 'barcode'>): boolean {
	return Boolean(item.image_url || item.barcode);
}
