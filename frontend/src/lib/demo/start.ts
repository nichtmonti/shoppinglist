// Into the demo ([D-234]): a throwaway account from the server, then example
// lists so the first screen is not empty.
import type { RecordModel } from 'pocketbase';
import { pb } from '#lib/pb.js';
import { importList, templateCategories } from '#lib/actions/lists.js';
import { backupDocument, type BackupItem } from '#lib/backup.js';
import { lookupBarcode, type LookupProduct } from '#lib/scan/lookup.js';
import { getLocale, t, type Locale } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';
import { DEMO_LIFETIME_MS } from '#lib/field-contract.js';
import { stampMs } from '#lib/time.js';

/**
 * Create a demo account and sign in to it. Rejects with a LocalizedError whose
 * message is the visitor's copy.
 */
export async function startDemo(): Promise<void> {
	const res = await fetch('/api/demo/start', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ lang: getLocale() })
	}).catch(() => null);
	if (!res?.ok) {
		const key =
			res?.status === 429
				? 'demo_start_too_many'
				: res?.status === 503
					? 'demo_start_full'
					: 'demo_start_failed';
		throw new LocalizedError(t(key));
	}
	const data = (await res.json()) as { token: string; record: RecordModel };
	pb.authStore.save(data.token, data.record);
}

/** When the signed-in demo account is deleted, or null when unknown. */
export function demoEndsAt(): number | null {
	const at = stampMs((pb.authStore.record as { created?: string } | null)?.created);
	return at === null ? null : at + DEMO_LIFETIME_MS;
}

/** Text in each of the app's languages. */
type Both = Record<Locale, string>;

/** What a list holds of an item beside its name. */
interface Shopping {
	quantity?: string;
	/** The same in both languages: a note has no second one. */
	note?: string;
	/** Already in the trolley, so the done pile shows too. */
	checked?: boolean;
	/** Bought that many days ago: off the active list, under "Frühere Artikel". */
	bought?: number;
}

/** An item typed in: its name per language, its aisle (a template slug). */
interface TypedItem extends Both, Shopping {
	/** null is an item the dictionary does not know, typed in by hand: no aisle. */
	slug: string | null;
}

/** A scanned product: the barcode lookup names and places it, and the demo
 *  server holds its photo (backend/internal/demo/products.go, [D-234]). */
interface ScannedItem extends Shopping {
	barcode: string;
}

type ExampleItem = TypedItem | ScannedItem;

interface ExampleList {
	/** The same in both languages: a list has one name for everyone ([D-08]). */
	name: string;
	items: readonly ExampleItem[];
}

// Names and aisles as in backend/seed/items.json, covering quantities, notes,
// an unknown item, scanned products, ticked ones and earlier purchases. Each
// item carries both names, so it follows a language switch as a scanned
// product does ([D-21]); a typed one would not. The weekly shop, last, is
// where the visitor lands.
export const EXAMPLE_LISTS: readonly ExampleList[] = [
	{
		name: 'Camping',
		items: [
			{ de: 'Sonnencreme', en: 'sunscreen', slug: 'personal_care', note: 'SPF 50' },
			{ de: 'Mückenspray', en: 'insect repellent', slug: 'personal_care' },
			{ de: 'Pflaster', en: 'plasters', slug: 'personal_care' },
			{ de: 'Batterien', en: 'batteries', slug: 'household', quantity: '8', note: 'AA' },
			{ de: 'Streichhölzer', en: 'matches', slug: 'household' },
			{ de: 'Müllbeutel', en: 'trash bags', slug: 'household' },
			{ de: 'Instantnudeln', en: 'instant noodles', slug: 'pasta_rice', quantity: '4' },
			{ de: 'Couscous', en: 'couscous', slug: 'pasta_rice' },
			{ de: 'Kidneybohnen', en: 'kidney beans', slug: 'pantry', quantity: '2' },
			{ de: 'Mais', en: 'corn', slug: 'pantry' },
			{ de: 'Marshmallows', en: 'marshmallows', slug: 'snacks_sweets' },
			{ de: 'Studentenfutter', en: 'trail mix', slug: 'snacks_sweets' },
			{ barcode: '4001686301555' },
			{ de: 'Instantkaffee', en: 'instant coffee', slug: 'coffee_tea' },
			{ de: 'Wasser', en: 'water', slug: 'beverages', quantity: '6 l' },
			{ barcode: '4029764001807', quantity: '6' },
			{ de: 'Teelichter', en: 'tea lights', slug: 'household', bought: 47 },
			{ de: 'Feuerzeug', en: 'lighter', slug: 'household', bought: 47 },
			{ de: 'Duschgel', en: 'shower gel', slug: 'personal_care', bought: 47 },
			{ de: 'Thunfisch', en: 'tuna', slug: 'meat_fish', bought: 47 },
			{ de: 'Zahnbürste', en: 'toothbrush', slug: 'personal_care', bought: 61 },
			{ de: 'Trockenfrüchte', en: 'dried fruit', slug: 'snacks_sweets', bought: 61 }
		]
	},
	{
		name: 'Barbecue',
		items: [
			{ de: 'Bratwurst', en: 'bratwurst', slug: 'meat_fish', quantity: '12', note: '50 % veggie' },
			{ de: 'Steak', en: 'steak', slug: 'meat_fish', quantity: '4' },
			{ de: 'Hähnchenbrust', en: 'chicken breast', slug: 'meat_fish', quantity: '1 kg' },
			{ de: 'Maiskolben', en: 'corn on the cob', slug: 'produce', quantity: '4' },
			{ de: 'Paprika', en: 'bell pepper', slug: 'produce', quantity: '3' },
			{ de: 'Zucchini', en: 'zucchini', slug: 'produce', quantity: '2' },
			{ de: 'Halloumi', en: 'halloumi', slug: 'dairy_eggs', quantity: '2' },
			{ de: 'Kartoffelsalat', en: 'potato salad', slug: 'dairy_eggs' },
			{ de: 'Baguette', en: 'baguette', slug: 'bakery', quantity: '2' },
			{ barcode: '87157239' },
			{ de: 'Senf', en: 'mustard', slug: 'pantry' },
			{ de: 'Barbecuesauce', en: 'BBQ sauce', slug: 'pantry' },
			{ de: 'Limonade', en: 'lemonade', slug: 'beverages', quantity: '6' },
			{ de: 'Mineralwasser', en: 'sparkling water', slug: 'beverages', quantity: '6' },
			{ de: 'Bier', en: 'beer', slug: 'alcohol', quantity: '24' },
			{ de: 'Eiswürfel', en: 'ice cubes', slug: 'frozen' },
			{ de: 'Grillkohle', en: 'charcoal', slug: 'hardware' },
			{ de: 'Grillanzünder', en: 'fire starters', slug: 'hardware' },
			{ de: 'Servietten', en: 'napkins', slug: 'household', bought: 20 },
			{ de: 'Pappteller', en: 'paper plates', slug: 'household', bought: 20 },
			{ de: 'Alufolie', en: 'aluminum foil', slug: 'household', bought: 20 },
			{ de: 'Chips', en: 'potato chips', slug: 'snacks_sweets', bought: 20 },
			{ barcode: '5449000000996', quantity: '6', bought: 34 },
			{ de: 'Wassermelone', en: 'watermelon', slug: 'produce', bought: 34 }
		]
	},
	{
		name: 'Basics',
		items: [
			{ de: 'Banane', en: 'banana', slug: 'produce', note: 'Fairtrade' },
			{ de: 'Tomate', en: 'tomato', slug: 'produce', quantity: '6' },
			{ de: 'Zwiebel', en: 'onion', slug: 'produce', quantity: '3' },
			{ de: 'Salat', en: 'lettuce', slug: 'produce' },
			{ de: 'Apfel', en: 'apple', slug: 'produce', quantity: '1 kg', checked: true },
			{ de: 'Milch', en: 'milk', slug: 'dairy_eggs', quantity: '2 l' },
			{ de: 'Käse', en: 'cheese', slug: 'dairy_eggs', quantity: '200 g', note: 'Gouda' },
			{ de: 'Joghurt', en: 'yogurt', slug: 'dairy_eggs', quantity: '4' },
			{ de: 'Eier', en: 'eggs', slug: 'dairy_eggs', quantity: '10' },
			{ de: 'Butter', en: 'butter', slug: 'dairy_eggs' },
			{ barcode: '5411188115366' },
			{ de: 'Brötchen', en: 'bread rolls', slug: 'bakery', quantity: '6' },
			{ de: 'Knäckebrot', en: 'crispbread', slug: 'bakery' },
			{ de: 'Brot', en: 'bread', slug: 'bakery', checked: true },
			{ de: 'Reis', en: 'rice', slug: 'pasta_rice' },
			{ barcode: '8076800195057' },
			{ de: 'Dosentomaten', en: 'canned tomatoes', slug: 'pantry', quantity: '2' },
			{ de: 'Linsen', en: 'lentils', slug: 'pantry' },
			{ de: 'Haferflocken', en: 'oats', slug: 'breakfast' },
			{ de: 'Marmelade', en: 'jam', slug: 'breakfast' },
			{ de: 'Kaffee', en: 'coffee', slug: 'coffee_tea', note: 'Espresso', checked: true },
			{ de: 'Spülmittel', en: 'dish soap', slug: 'household' },
			{ de: 'Schwämme', en: 'sponges', slug: 'household' },
			{ de: 'Geschenkpapier', en: 'wrapping paper', slug: null },
			{ de: 'Nudeln', en: 'pasta', slug: 'pasta_rice', bought: 2 },
			{ de: 'Gurke', en: 'cucumber', slug: 'produce', bought: 5 },
			{ de: 'Paprika', en: 'bell pepper', slug: 'produce', bought: 5 },
			{ de: 'Orangensaft', en: 'orange juice', slug: 'beverages', bought: 5 },
			{ barcode: '4000417025005', bought: 5 },
			{ de: 'Olivenöl', en: 'olive oil', slug: 'pantry', bought: 9 },
			{ de: 'Mehl', en: 'flour', slug: 'baking_spices', bought: 9 },
			{ de: 'Kartoffel', en: 'potato', slug: 'produce', quantity: '2 kg', bought: 12 },
			{ de: 'Zucker', en: 'sugar', slug: 'baking_spices', bought: 16 },
			{ de: 'Toilettenpapier', en: 'toilet paper', slug: 'household', bought: 16 },
			{ de: 'Tee', en: 'tea', slug: 'coffee_tea', bought: 23 },
			{ de: 'Waschmittel', en: 'laundry detergent', slug: 'household', bought: 23 },
			{ de: 'Müsli', en: 'muesli', slug: 'breakfast', bought: 23 },
			{ de: 'Honig', en: 'honey', slug: 'breakfast', bought: 30 }
		]
	}
];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Create the example lists through the list-backup import ([D-72]), the one
 * way in that keeps purchase dates, so earlier trips show under "Frühere
 * Artikel" with their own days. Returns the id of the last one, the weekly
 * shop, which the visitor is taken to.
 */
export async function createExampleList(): Promise<string> {
	const lang = getLocale();
	const [products, categories] = await Promise.all([lookUpProducts(), templateCategories()]);
	const slugs = new Set(categories.map((c) => c.key));
	const now = Date.now();
	let listId = '';
	for (const example of EXAMPLE_LISTS) {
		const rows = example.items.flatMap((item, i) => {
			const row = exampleRow(item, products, lang, slugs, now - i * MINUTE_MS);
			return row ? [row] : [];
		});
		listId = await importList(backupDocument(example.name, categories, rows), example.name);
	}
	return listId;
}

/** The example products' lookups, by barcode: answered from the demo
 *  server's own cache. One without an answer (the scanner off) is left out. */
async function lookUpProducts(): Promise<Map<string, LookupProduct>> {
	const barcodes = new Set(
		EXAMPLE_LISTS.flatMap((list) =>
			list.items.flatMap((item) => ('barcode' in item ? [item.barcode] : []))
		)
	);
	const results = await Promise.all(
		[...barcodes].map(async (barcode) => [barcode, await lookupBarcode(barcode)] as const)
	);
	return new Map(
		results.flatMap(([barcode, r]) => (r.kind === 'found' ? [[barcode, r.product] as const] : []))
	);
}

/** One example item as a backup row, stamped as the push route stamps a
 *  tick: in this trip a minute apart (`at`), or `bought` days before. A
 *  scanned one carries its barcode, from which the server sets its photo
 *  ([D-266]); null when its lookup had no answer. */
function exampleRow(
	item: ExampleItem,
	products: Map<string, LookupProduct>,
	lang: Locale,
	slugs: Set<string>,
	at: number
): BackupItem | null {
	const ticked = item.bought === undefined ? (item.checked ? at : null) : at - item.bought * DAY_MS;
	const stamp = ticked === null ? null : new Date(ticked).toISOString();
	const shopping = {
		quantity: item.quantity ?? '',
		note: item.note ?? null,
		image_url: null,
		checked: stamp !== null,
		...(stamp !== null && { checked_at: stamp, last_bought_at: stamp })
	};
	if ('barcode' in item) {
		const product = products.get(item.barcode);
		if (!product) return null;
		return {
			...shopping,
			name: product.name,
			name_de: product.name_de ?? undefined,
			name_en: product.name_en ?? undefined,
			category_key:
				product.category_slug && slugs.has(product.category_slug) ? product.category_slug : null,
			barcode: item.barcode
		};
	}
	return {
		...shopping,
		name: item[lang],
		name_de: item.de,
		name_en: item.en,
		category_key: item.slug !== null && slugs.has(item.slug) ? item.slug : null,
		barcode: null
	};
}
