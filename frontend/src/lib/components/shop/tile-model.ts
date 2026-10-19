// What a shop tile shows, decided without a DOM (§9.1, [D-83]); ShopTile adds
// what only layout knows, whether the text is cut.
import type { Item } from '#lib/db.js';
import { displayName, isScanned } from '#lib/item-name.js';

export interface TileModel {
	/** Scan provenance, not picture availability: a scanned item with no usable
	 *  image is still a product tile, on the placeholder ([D-83]). */
	kind: 'typed' | 'product';
	/** A row shows the photo as a thumbnail in its icon's place ([D-331]). */
	media: 'photo' | 'placeholder' | 'thumb' | 'none';
	name: string;
	note: string;
	quantity: string;
	/** The sheet holds something the tile does not show: a barcode, which no
	 *  tile has room for ([D-83]), or a row's photo, which its thumbnail only
	 *  hints at ([D-313], [D-331]). */
	hidesDetails: boolean;
}

/** The category mark a row leads with where no aisle header names it. */
export interface TileMark {
	icon: string | null;
	color: string | null;
	name: string;
}

interface TileOptions {
	/** The photo errored; the grid tile shows the placeholder (§9.2). */
	photoFailed?: boolean;
	/** The row shape, whose photo is a thumbnail in the category icon's
	 *  place, so every name starts at the same edge ([D-313], [D-331]). */
	row?: boolean;
}

export function tileModel(
	item: Item,
	{ photoFailed = false, row = false }: TileOptions = {}
): TileModel {
	const kind = isScanned(item) ? 'product' : 'typed';
	return {
		kind,
		media:
			item.image_url && !photoFailed
				? row
					? 'thumb'
					: 'photo'
				: kind === 'product' && !row
					? 'placeholder'
					: 'none',
		name: displayName(item),
		note: item.note ?? '',
		quantity: item.quantity,
		hidesDetails: Boolean(item.barcode || (row && item.image_url))
	};
}

/**
 * The ⓘ door shows exactly while the tile hides something the sheet would
 * show: cut text, or details no tile size has room for ([D-83]). `kind`
 * decides the layout, never the door.
 */
export function showsDoor(model: TileModel, textCut: boolean): boolean {
	return model.hidesDetails || textCut;
}

/**
 * The accessible name of a tile or done row: its visible parts, comma-joined
 * ([D-213]). The tile's text is aria-hidden under the covering check button
 * ([D-83]), so this is all a screen reader hears.
 */
export function spokenName(parts: ReadonlyArray<string | null | undefined>): string {
	return parts
		.map((part) => part?.trim() ?? '')
		.filter(Boolean)
		.join(', ');
}
