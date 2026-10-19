// Plain-logic coverage for §9.2's online lookup half: the proxy fetch, the
// "a match with no name is not usable" edge case, and transport-error
// resilience. No DOM, no Dexie — the transport is injected (LookupTransport),
// same shape as #lib/sync/push.ts's PushTransport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authStore } = vi.hoisted(() => ({ authStore: { token: '' } }));
vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({ authStore })
);

import { setLocale } from '#lib/i18n/index.js';
import { BARCODE_ENDPOINT, lookupBarcode } from './lookup';

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

describe('lookupBarcode', () => {
	it('returns the product from the authenticated backend proxy', async () => {
		const transport = vi.fn().mockResolvedValue(
			jsonResponse({
				name: 'Nutella',
				name_de: 'Nuss-Nougat-Creme',
				image_url: 'https://images.example/nutella.jpg',
				category_slug: 'pantry'
			})
		);

		const result = await lookupBarcode('3017620422003', transport);

		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport).toHaveBeenCalledWith(BARCODE_ENDPOINT('3017620422003'));
		// The localized names ride along for the item to carry ([D-21]); one
		// the upstream lacks (no name_en here) reads as null.
		expect(result).toEqual({
			kind: 'found',
			product: {
				name: 'Nutella',
				name_de: 'Nuss-Nougat-Creme',
				name_en: null,
				image_url: 'https://images.example/nutella.jpg',
				category_slug: 'pantry'
			}
		});
	});

	// [D-21]: the server names the product in the language the app is
	// showing, so the request has to say which one that is.
	it.each(['de', 'en'] as const)(
		'asks for the product name in the UI language (%s)',
		async (locale) => {
			setLocale(locale);
			const transport = vi.fn().mockResolvedValue(jsonResponse({ name: 'Nutella' }));

			await lookupBarcode('3017620422003', transport);

			expect(transport).toHaveBeenCalledWith(`/api/barcode/3017620422003?lang=${locale}`);
		}
	);

	it("reads the proxy's 404 as a miss", async () => {
		const transport = vi
			.fn()
			.mockResolvedValue(jsonResponse({ message: 'barcode not found' }, 404));

		const result = await lookupBarcode('4005808307870', transport);

		expect(transport).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ kind: 'miss' });
	});

	it('reads a match without a usable name as a miss', async () => {
		const transport = vi.fn().mockResolvedValue(jsonResponse({ image_url: '/x.jpg' }));

		expect(await lookupBarcode('999', transport)).toEqual({ kind: 'miss' });
	});

	// A failure is not an answer: resolve.ts caches a miss for a day, so a
	// flaky connection or a busy server must not read as "unknown barcode".
	it('treats a transport failure (e.g. timeout) as an error, not a thrown one', async () => {
		const transport = vi.fn().mockRejectedValue(new Error('timeout'));

		expect(await lookupBarcode('999', transport)).toEqual({ kind: 'error' });
	});

	it.each([401, 429, 500])('treats HTTP %i as an error, not a miss', async (status) => {
		const transport = vi.fn().mockResolvedValue(jsonResponse({}, status));

		expect(await lookupBarcode('999', transport)).toEqual({ kind: 'error' });
	});

	it('treats an unreadable body as an error', async () => {
		const transport = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError()) });

		expect(await lookupBarcode('999', transport)).toEqual({ kind: 'error' });
	});
});

// Regression: the proxy sits behind security.RequireAuth, so the DEFAULT
// transport — the one every real scan uses, and the one every test above
// substitutes away — must carry the bearer token. Without it the backend
// answered 401 and every single scan reported "no results". Nothing caught it because the injected-transport tests bypass
// the exact code that was wrong.
describe('lookupBarcode default transport', () => {
	beforeEach(() => {
		authStore.token = 'tok-123';
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ name: 'Nutella' })
			})
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends the PocketBase auth token as a bearer header', async () => {
		const result = await lookupBarcode('3017620422003');

		expect(result).toMatchObject({ kind: 'found', product: { name: 'Nutella' } });
		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe(BARCODE_ENDPOINT('3017620422003'));
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-123');
	});

	it('omits the header entirely when there is no token', async () => {
		authStore.token = '';

		await lookupBarcode('3017620422003');

		const [, init] = vi.mocked(fetch).mock.calls[0];
		expect(new Headers(init?.headers).get('Authorization')).toBeNull();
	});
});
