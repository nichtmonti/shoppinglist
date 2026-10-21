// §9.2 step 2 coverage: cache-first (offline-capable), the one networked step
// skipped entirely when offline, and caching a fresh online hit for next time.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/db.js';
import { endSession } from '#lib/auth/session.js';
import { resetDb } from '#lib/test-kit/db.js';
import { LOOKUP_FAILED, resolveScannedProduct } from './resolve';
import { BARCODE_ENDPOINT } from './lookup';

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

describe('resolveScannedProduct', () => {
	beforeEach(async () => {
		await resetDb();
	});

	it('a cached hit resolves without any network call', async () => {
		await db.scanned_products.put({
			barcode: '3017620422003',
			name: 'Nutella',
			image_url: 'https://images.example/nutella.jpg',
			category_slug: 'pantry',
			looked_up_at: new Date().toISOString()
		});
		const transport = vi.fn();

		const result = await resolveScannedProduct('3017620422003', { transport });

		expect(transport).not.toHaveBeenCalled();
		// An entry cached before [D-21] carries no localized names: null, not
		// undefined, so the created item's columns stay well-typed.
		expect(result).toEqual({
			name: 'Nutella',
			name_de: null,
			name_en: null,
			image_url: 'https://images.example/nutella.jpg',
			category_slug: 'pantry',
			fromCache: true
		});
	});

	it('a cache miss with a successful online lookup resolves the product and caches it', async () => {
		const transport = vi.fn().mockResolvedValue(
			jsonResponse({
				name: 'Nutella',
				image_url: 'https://images.example/nutella.jpg',
				category_slug: 'pantry'
			})
		);

		const result = await resolveScannedProduct('3017620422003', {
			transport,
			isOnline: () => true
		});

		expect(transport).toHaveBeenCalledWith(BARCODE_ENDPOINT('3017620422003'));
		expect(result?.name).toBe('Nutella');
		expect(result?.fromCache).toBe(false);

		const cached = await db.scanned_products.get('3017620422003');
		expect(cached).toMatchObject({ barcode: '3017620422003', name: 'Nutella' });
	});

	it('a lookup miss everywhere resolves to null and caches the negative result', async () => {
		const transport = vi.fn().mockResolvedValue(jsonResponse({}, 404));

		const result = await resolveScannedProduct('0000000000000', {
			transport,
			isOnline: () => true
		});

		expect(result).toBeNull();
		const cached = await db.scanned_products.get('0000000000000');
		expect(cached?.found).toBe(false);
	});

	// A day-long negative cache is only for an ANSWER. A failed lookup (flaky
	// Wi-Fi, a busy or broken proxy) must leave the next scan free to ask again.
	it.each([
		['a transport failure', () => Promise.reject(new Error('timeout'))],
		['a 500', () => Promise.resolve(jsonResponse({ message: 'unavailable' }, 500))],
		['a 429', () => Promise.resolve(jsonResponse({}, 429))]
	])('%s resolves to a failure and caches nothing', async (_label, respond) => {
		const transport = vi.fn(respond);

		const result = await resolveScannedProduct('5000000000000', {
			transport,
			isOnline: () => true
		});

		expect(result).toBe(LOOKUP_FAILED);
		expect(await db.scanned_products.get('5000000000000')).toBeUndefined();
	});

	// [D-109]: a sign-out mid-lookup wipes scanned_products; the late answer
	// must not repopulate the next account's device-local cache.
	it.each([
		['hit', { name: 'Nutella' }, 200],
		['miss', {}, 404]
	])('writes nothing when the session ended during the lookup (%s)', async (_l, body, status) => {
		const transport = vi.fn(async () => {
			endSession();
			return jsonResponse(body, status);
		});

		await resolveScannedProduct('6000000000000', { transport, isOnline: () => true });

		expect(await db.scanned_products.get('6000000000000')).toBeUndefined();
	});

	it('a cached miss returns null without any network call', async () => {
		await db.scanned_products.put({
			barcode: '4000000000000',
			found: false,
			looked_up_at: new Date().toISOString()
		});
		const transport = vi.fn();

		const result = await resolveScannedProduct('4000000000000', { transport });

		expect(transport).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});

	it('offline: skips the network call entirely and resolves to null', async () => {
		const transport = vi.fn();

		const result = await resolveScannedProduct('3017620422003', {
			transport,
			isOnline: () => false
		});

		expect(transport).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});
});
