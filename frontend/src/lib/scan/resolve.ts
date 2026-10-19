// §9.2 step 2: resolve a scanned barcode to a product.
import { db } from '#lib/db.js';
import { sessionScope } from '#lib/auth/session.js';
import { isOnline } from '#lib/state/online.js';
import { lookupBarcode, type LookupTransport } from './lookup';

export interface ResolvedProduct {
	name: string;
	name_de: string | null;
	name_en: string | null;
	image_url: string | null;
	category_slug: string | null;
	/** True when this came from the device-local cache, without a network call. */
	fromCache: boolean;
}

const SUCCESS_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_CACHE_MS = 24 * 60 * 60 * 1000;
const inFlight = new Map<string, Promise<ResolvedProduct | null>>();

export interface ResolveDeps {
	transport?: LookupTransport;
	/** Defaults to #lib/state/online's navigator.onLine. */
	isOnline?: () => boolean;
}

/**
 * Resolves a scanned EAN/UPC to a product, or null on a miss or a failed
 * lookup (the caller falls back to typing, §9.2). Cache first, then the server
 * when online. `scanned_products` is device-local and never synced, so it is
 * written directly, bypassing the outbox. A miss is cached only when the
 * server answered one; a failed lookup is asked again next scan.
 */
export async function resolveScannedProduct(
	barcode: string,
	deps: ResolveDeps = {}
): Promise<ResolvedProduct | null> {
	const running = inFlight.get(barcode);
	if (running) return running;
	const work = resolveScannedProductOnce(barcode, deps);
	inFlight.set(barcode, work);
	try {
		return await work;
	} finally {
		if (inFlight.get(barcode) === work) inFlight.delete(barcode);
	}
}

async function resolveScannedProductOnce(
	barcode: string,
	deps: ResolveDeps
): Promise<ResolvedProduct | null> {
	const cached = await db.scanned_products.get(barcode);
	const age = cached ? Date.now() - Date.parse(cached.looked_up_at) : Infinity;
	const maxAge = cached?.found === false ? MISS_CACHE_MS : SUCCESS_CACHE_MS;
	const fresh = cached && age >= 0 && age < maxAge;
	if (cached && fresh && cached.found !== false && cached.name) {
		return {
			name: cached.name,
			// An entry cached before [D-21] has neither; it fills in on refetch.
			name_de: cached.name_de ?? null,
			name_en: cached.name_en ?? null,
			image_url: cached.image_url ?? null,
			category_slug: cached.category_slug ?? null,
			fromCache: true
		};
	}
	if (cached && fresh && cached.found === false) return null;

	if (!(deps.isOnline ?? isOnline)()) return null;

	const session = sessionScope();
	const result = await lookupBarcode(barcode, deps.transport);
	if (result.kind === 'error') return null;
	// A sign-out while the lookup was in flight has wiped scanned_products
	// ([D-109]); the answer must not be written back behind it.
	const owned = session.owned();
	if (result.kind === 'miss') {
		if (owned) {
			await db.scanned_products.put({
				barcode,
				found: false,
				looked_up_at: new Date().toISOString()
			});
		}
		return null;
	}

	const found = result.product;
	if (owned) {
		await db.scanned_products.put({
			barcode,
			found: true,
			name: found.name,
			name_de: found.name_de ?? undefined,
			name_en: found.name_en ?? undefined,
			image_url: found.image_url ?? undefined,
			category_slug: found.category_slug ?? undefined,
			looked_up_at: new Date().toISOString()
		});
	}

	return {
		name: found.name,
		name_de: found.name_de,
		name_en: found.name_en,
		image_url: found.image_url,
		category_slug: found.category_slug,
		fromCache: false
	};
}
