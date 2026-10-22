import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
import { maxBytesFor } from '#lib/field-contract.js';
import seed from '../../../../../backend/seed/categories.json';

/* The gallery's test data. A case is a named item text with a stable id; what
   the item looks like as a scan or a photo is applied by `withKind`, and which
   cases are shown, and in what state, is chosen by `fixtures`. The ids are the
   gallery's contract with its harnesses: a fixture item's id IS its case id,
   and the views mark each item's cell `data-item="<id>"`, so a finding names
   the case, not a slice of its text. */

/* A stand-in photo: a gradient plus a glyph, encoded inline. Real product
   images are proxied through our own origin (§9.2 [D-21]); what matters for
   layout is only that something opaque and mid-dark sits under the scrim. */
function photo(from: string, to: string, glyph: string): string {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">` +
		`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
		`</linearGradient></defs><rect width="240" height="240" fill="url(#g)"/>` +
		`<text x="120" y="152" font-size="104" text-anchor="middle">${glyph}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function packagePhoto(width: number, height: number, background: string): string {
	return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/><rect x="10%" y="10%" width="80%" height="80%" rx="8" fill="#30744d"/><text x="50%" y="52%" text-anchor="middle" fill="white" font-family="sans-serif" font-size="22">BIO</text></svg>`)}`;
}

const BROKEN_IMAGE = 'data:image/png;base64,broken';
const BARCODE = '4000000000001';

/* The aisles are the app's own (backend/seed/categories.json), copied as a
   new list copies them (§7.5): unnamed, so the template names them in the
   gallery's locale, with the seed's icon, colour and order. The ids are the
   gallery's, as the cases name them. */
const SEED_SLUG = {
	dairy: 'dairy_eggs',
	sweets: 'snacks_sweets',
	veg: 'produce',
	home: 'household',
	others: 'other'
} as const;
type CatId = keyof typeof SEED_SLUG;

export const TEMPLATES = new Map<string, CategoryTemplate>(
	(seed as (Omit<CategoryTemplate, 'retired'> & { retired?: boolean })[]).map((t) => [
		t.slug,
		{ ...t, retired: t.retired === true }
	])
);

export const CATS: ListCategory[] = Object.entries(SEED_SLUG).map(([id, slug]) => {
	const template = TEMPLATES.get(slug);
	if (!template) throw new Error(`no seed category ${slug}`);
	return {
		id,
		list: 'demo',
		slug,
		name: null,
		icon: template.icon,
		color: template.color,
		sort_order: template.sort_order,
		updated: '',
		created: '',
		deleted_at: null
	};
});

/* Each aisle's stand-in photo for the `photo` kind. */
const PHOTOS: Record<CatId, string> = {
	dairy: photo('#c9d6b5', '#7f9a5e', '🥛'),
	sweets: photo('#e8cfa8', '#b98d4e', '🍫'),
	veg: photo('#d8c4c4', '#a06a6a', '🍅'),
	home: photo('#c6d3dd', '#6f8ba1', '🧴'),
	others: photo('#cfd9c8', '#869a76', '🥔')
};

/** How an item came to be: typed, scanned without a photo, scanned with one,
 *  or scanned with a photo that fails to load. */
type Kind = 'plain' | 'scan' | 'photo' | 'failed';

export interface Case {
	/** Stable, unique, kebab-case: the case's name in URLs and findings. */
	id: string;
	/** What the case is about, for the gallery's captions. */
	label: string;
	cat: CatId;
	item: Pick<Item, 'name'> & Partial<Pick<Item, 'quantity' | 'note'>>;
	/** The kind this case shows in a mixed list; plain when absent. */
	kind?: Kind;
	/** The photo for the photo kind; the aisle's stand-in when absent. */
	image?: string;
}

/* Every text case the views have to survive. The first twelve are the
   everyday mix; the rest are limits, edge shapes and writing directions. */
export const TEXT_CASES: readonly Case[] = [
	{ id: 'short', label: 'kurz, ohne alles', cat: 'dairy', item: { name: 'Milch' } },
	{
		id: 'short-qty',
		label: 'kurz + Menge',
		cat: 'dairy',
		item: { name: 'Butter', quantity: '250 g' }
	},
	{
		id: 'two-line',
		label: 'zweizeilig',
		cat: 'dairy',
		item: { name: 'Bio Vollmilch 3,5%', quantity: '1 l' },
		kind: 'photo'
	},
	{
		id: 'compound',
		label: 'Kompositum',
		cat: 'home',
		item: { name: 'Spülmaschinentabs', quantity: '1 Pkg.' },
		kind: 'scan'
	},
	{
		id: 'long-compound',
		label: 'langes Kompositum',
		cat: 'sweets',
		item: { name: 'Vollmilchschokolade', quantity: '2 Tafeln' }
	},
	{
		id: 'extreme',
		label: 'Extremfall',
		cat: 'sweets',
		item: { name: 'Haselnuss-Vollmilchschokolade mit Nougatfüllung', quantity: '3' }
	},
	{
		id: 'note',
		label: 'mit Notiz',
		cat: 'veg',
		item: { name: 'Tomaten', quantity: '500 g', note: 'reif, aber fest' }
	},
	{
		id: 'long-note',
		label: 'lange Notiz',
		cat: 'dairy',
		item: { name: 'Bergkäse', quantity: '200 g', note: 'am Stück, bitte nicht gerieben' },
		kind: 'failed'
	},
	{ id: 'other-aisle', label: 'anderer Gang', cat: 'veg', item: { name: 'Kartoffeln' } },
	{
		id: 'note-qty',
		label: 'Notiz + Menge',
		cat: 'dairy',
		item: { name: 'Eier', quantity: '10', note: 'Bodenhaltung' }
	},
	{
		id: 'long-qty',
		label: 'lange Menge',
		cat: 'home',
		item: { name: 'Nudeln', quantity: '2 Packungen à 500 g' }
	},
	{
		id: 'full-name-qty',
		label: 'voller Name + Menge',
		cat: 'sweets',
		item: { name: 'Haselnuss-Vollmilchschokolade', quantity: '2 Tafeln' }
	},
	{
		id: 'endless-name',
		label: 'Name ohne Ende',
		cat: 'sweets',
		item: {
			name: 'Sonderangebot der Woche: Bio Vollmilchschokolade mit Haselnüssen und Nougatfüllung',
			quantity: '3'
		}
	},
	{
		id: 'name-note',
		label: 'Name + Notiz',
		cat: 'dairy',
		item: {
			name: 'Haselnuss-Vollmilchschokolade mit Nougatfüllung',
			note: 'Nur die mit der hellen Verpackung'
		}
	},
	{
		id: 'everything',
		label: 'alles gleichzeitig',
		cat: 'sweets',
		item: {
			name: 'Vollmilchschokolade mit Haselnüssen und Krokant',
			quantity: '3 Tafeln',
			note: 'im Sonderangebot'
		}
	},
	{
		id: 'endless-note',
		label: 'Notiz endlos',
		cat: 'dairy',
		item: {
			name: 'Joghurt',
			quantity: '500 g',
			note: 'Natur, griechischer Stil, 10 % Fett — bitte aus dem Kühler ganz hinten links'
		}
	},
	{
		id: 'single-word',
		label: 'ein einziges Wort',
		cat: 'sweets',
		item: { name: 'Superkalifragilistischexpialigetisch', quantity: '1 Pkg.' }
	},
	{
		// At 390px a few pixels wider than a comfortable tile's line, which the
		// padding the name may use ([D-83]) gives back.
		id: 'near-fit',
		label: 'knapp zu breit',
		cat: 'others',
		item: { name: 'Knoblauchpulver', quantity: '1 Glas' }
	},
	{
		id: 'field-limits',
		label: 'Feldgrenzen',
		cat: 'sweets',
		item: {
			name: 'Haselnuss-Vollmilchschokolade '.repeat(20).slice(0, maxBytesFor('items', 'name')),
			quantity: 'Packung'.repeat(20).slice(0, maxBytesFor('items', 'quantity')),
			note: 'Bitte die ungesüßte Variante. '.repeat(30).slice(0, maxBytesFor('items', 'note'))
		}
	},
	{
		id: 'emoji',
		label: 'Emoji & Sonderzeichen',
		cat: 'veg',
		item: { name: 'Äpfel 🍎 & Birnen', quantity: '½ kg', note: 'süß–säuerlich' }
	},
	{
		id: 'rtl',
		label: 'Andere Schreibrichtung',
		cat: 'others',
		item: { name: 'حليب كامل الدسم', quantity: '٢ لتر', note: 'بدون سكر' }
	}
];

/* Photo shapes and failures: one item text, the picture varies. Their kind is
   the point of the case, so a kind override does not apply to them. */
function photoCase(id: string, label: string, kind: Kind, image?: string): Case {
	return {
		id,
		label,
		cat: 'dairy',
		item: { name: label, quantity: '1 Pkg.', note: 'Bitte die ungesüßte Variante' },
		kind,
		image
	};
}
export const PHOTO_CASES: readonly Case[] = [
	photoCase('photo-light', 'Helle Verpackung', 'photo', packagePhoto(240, 240, '#ffffff')),
	photoCase('photo-dark', 'Dunkle Verpackung', 'photo', packagePhoto(240, 240, '#101510')),
	photoCase('photo-portrait', 'Hochformat', 'photo', packagePhoto(100, 300, '#f2e6cc')),
	photoCase('photo-landscape', 'Querformat', 'photo', packagePhoto(300, 100, '#dcead2')),
	photoCase(
		'photo-transparent',
		'Transparenter Hintergrund',
		'photo',
		packagePhoto(200, 240, 'none')
	),
	photoCase('photo-failed', 'Bildfehler', 'failed'),
	photoCase('photo-none', 'Kein Produktfoto', 'scan')
];

/** Which cases a preview shows. */
export type Content = 'everyday' | 'stress' | 'photos';
/** The list's state around those cases. */
export type ListState = 'normal' | 'done' | 'empty' | 'loading';
/** A kind for every case, or each case's own (`mixed`). */
export type KindChoice = 'mixed' | Kind;

export const CONTENT: Record<Content, { cases: readonly Case[]; kinds: boolean }> = {
	everyday: { cases: TEXT_CASES.slice(0, 12), kinds: true },
	stress: { cases: TEXT_CASES, kinds: true },
	photos: { cases: PHOTO_CASES, kinds: false }
};

/** The item fields that make a case typed, scanned or photographed. */
function withKind(c: Case, kind: Kind): Pick<Item, 'barcode' | 'image_url'> {
	switch (kind) {
		case 'plain':
			return { barcode: null, image_url: null };
		case 'scan':
			return { barcode: BARCODE, image_url: null };
		case 'photo':
			return { barcode: BARCODE, image_url: c.image ?? PHOTOS[c.cat] };
		case 'failed':
			return { barcode: BARCODE, image_url: BROKEN_IMAGE };
	}
}

export type Fixture = { id: string; label: string; item: Item };

export function fixtures(content: Content, state: ListState, kind: KindChoice): Fixture[] {
	if (state === 'empty' || state === 'loading') return [];
	const { cases, kinds } = CONTENT[content];
	const checkedAt = state === 'done' ? new Date().toISOString() : null;
	return cases.map((c) => ({
		id: c.id,
		label: c.label,
		item: {
			// The case id: previews mark each item's cell with data-item.
			id: c.id,
			list: 'demo',
			name: c.item.name,
			name_de: null,
			name_en: null,
			quantity: c.item.quantity ?? '',
			note: c.item.note ?? null,
			category_key: c.cat,
			checked: state === 'done',
			checked_at: checkedAt,
			last_bought_at: null,
			...withKind(c, kinds && kind !== 'mixed' ? kind : (c.kind ?? 'plain')),
			modified_by: null,
			updated: '',
			created: '',
			deleted_at: null
		}
	}));
}
