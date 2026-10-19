// §9.2 step 2, online half: the authenticated backend proxy does the Open Food
// Facts lookup and caches it server-side. The ONE networked step of §9.2;
// resolve.ts skips it when offline.

import { getLocale, type Locale } from '#lib/i18n/index.js';
import { authHeaders } from '#lib/pb.js';

/** `lang` asks for the product's name in the UI language where the upstream
 * has one ([D-21]); the server falls back to the main-language name. */
export const BARCODE_ENDPOINT = (ean: string, lang: Locale = getLocale()): string =>
	`/api/barcode/${encodeURIComponent(ean)}?lang=${lang}`;

export interface LookupProduct {
	name: string;
	/** The product's localized names, which the created item carries ([D-21]). */
	name_de: string | null;
	name_en: string | null;
	image_url: string | null;
	category_slug: string | null;
}

/** Fetches one URL; injectable for tests. */
export type LookupTransport = (url: string) => Promise<Response>;

// The proxy requires auth, read from the Authorization header only: without it
// every lookup is a silent 401. The timeout keeps a hung fetch from stalling
// the fallback to typing, but outlasts a first lookup: the server may ask Open
// Food Facts and a sister site, 5 s each, then wait 3 s for the photo before
// answering without it ([D-21]); given up sooner, a slow upstream read as "not
// found" though the server went on to find and cache it. The overlay can be
// closed meanwhile.
const LOOKUP_TIMEOUT_MS = 12_000;
const defaultTransport: LookupTransport = (url) => {
	return fetch(url, {
		headers: authHeaders(),
		signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
	});
};

interface ProxyResponse {
	name?: string;
	name_de?: string;
	name_en?: string;
	image_url?: string;
	category_slug?: string;
}

/**
 * A lookup's three outcomes. `miss` is the server's answer that the barcode is
 * unknown (a 404, or a product without a usable name) and is worth caching;
 * `error` is no answer at all (offline, timeout, 401, 429, 5xx, a garbled
 * body) and must not be cached — the next scan should ask again.
 */
export type LookupResult =
	{ kind: 'found'; product: LookupProduct } | { kind: 'miss' } | { kind: 'error' };

const ERROR: LookupResult = { kind: 'error' };
const MISS: LookupResult = { kind: 'miss' };

async function fetchProxy(url: string, transport: LookupTransport): Promise<LookupResult> {
	let resp: Response;
	try {
		resp = await transport(url);
	} catch {
		return ERROR;
	}
	if (resp.status === 404) return MISS;
	if (!resp.ok) return ERROR;
	let body: ProxyResponse;
	try {
		body = (await resp.json()) as ProxyResponse;
	} catch {
		return ERROR;
	}
	if (!body.name) return MISS;
	return {
		kind: 'found',
		product: {
			name: body.name,
			name_de: body.name_de || null,
			name_en: body.name_en || null,
			image_url: body.image_url ?? null,
			category_slug: body.category_slug ?? null
		}
	};
}

/** Calls the same-origin backend proxy. */
export async function lookupBarcode(
	barcode: string,
	transport: LookupTransport = defaultTransport
): Promise<LookupResult> {
	return fetchProxy(BARCODE_ENDPOINT(barcode), transport);
}
