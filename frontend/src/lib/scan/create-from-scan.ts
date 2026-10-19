// §9.2 step 3: create the scanned item, or jump to an existing one (scan-dedup).
import { addItem, applyDedupHit, attachBarcode } from '#lib/actions/items.js';
import { buildCorpus, classify } from '#lib/classify.js';
import { db, type Item, type ListCategory } from '#lib/db.js';
import { findByBarcode, findByName } from '#lib/dedup.js';
import { getLocale } from '#lib/i18n/index.js';
import type { ResolvedProduct } from './resolve';

export interface CreateFromScanResult {
	itemId: string;
	created: boolean;
}

/**
 * Resolves the product's category slug to THIS list's `list_categories` row id
 * (§6.6). Null (Others) when the slug is missing or the list has no live
 * category with it.
 */
export function resolveCategoryKey(slug: string | null, categories: ListCategory[]): string | null {
	if (!slug) return null;
	const match = categories.find((c) => c.slug === slug && c.deleted_at === null);
	return match ? match.id : null;
}

/**
 * A dedup hit behaves EXACTLY like typing that name (§9.1/§9.2 door parity), so
 * this is `applyDedupHit`. A CHECKED match must be re-activated: otherwise the
 * scan resolves to a row rendered nowhere, and the scanner seems to do nothing.
 */
async function jumpTo(match: Item): Promise<CreateFromScanResult> {
	await applyDedupHit(match);
	return { itemId: match.id, created: false };
}

/**
 * Creates (or jumps to) the item for a resolved scan: barcode dedup first, then
 * name dedup (the item may have been typed, never scanned, and then takes the
 * barcode), against THIS list's items only.
 */
export async function createItemFromScan(
	listId: string,
	barcode: string,
	product: ResolvedProduct,
	items: Item[],
	categories: ListCategory[]
): Promise<CreateFromScanResult> {
	const barcodeMatch = findByBarcode(items, barcode);
	if (barcodeMatch) return jumpTo(barcodeMatch);

	// Any of the product's names: a member may have typed the German one.
	for (const name of [product.name, product.name_de, product.name_en]) {
		const nameMatch = name ? findByName(items, name) : undefined;
		if (nameMatch) {
			await attachBarcode(nameMatch, barcode, product.image_url);
			return jumpTo(nameMatch);
		}
	}

	// The server's tag mapping misses often, so fall back to the typeahead's
	// head-noun classifier (§9). Reads the dictionary directly rather than adding
	// a subscription to ScanButton for the rare path.
	const category_key =
		resolveCategoryKey(product.category_slug, categories) ??
		classify(
			product.name,
			buildCorpus(await db.item_dictionary.toArray(), items, categories, getLocale())
		);
	const itemId = await addItem(listId, {
		name: product.name,
		name_de: product.name_de,
		name_en: product.name_en,
		barcode,
		image_url: product.image_url,
		category_key
	});
	return { itemId, created: true };
}
