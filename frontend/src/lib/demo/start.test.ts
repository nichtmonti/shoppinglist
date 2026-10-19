// The demo's way in ([D-234]): what a refused start tells the visitor, what a
// successful one stores, and when the banner says the account goes.
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted(() => ({
	isValid: false,
	token: '',
	record: null as { id: string; created?: string } | null,
	onChange: vi.fn(),
	save: vi.fn(),
	clear: vi.fn()
}));

vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({ authStore, send: vi.fn() })
);

import { EXAMPLE_LISTS, demoEndsAt, startDemo } from './start';
import { demo } from './off';
import { setLocale } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';

const fetchMock = vi.fn();

beforeEach(() => {
	setLocale('de');
	authStore.record = null;
	authStore.save.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('startDemo', () => {
	it('stores the session the server answers with, and says which language to name it in', async () => {
		const record = { id: 'a1', nickname: 'Gast 1234' };
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ token: 'tok', record }), { status: 200 })
		);
		await startDemo();
		expect(authStore.save).toHaveBeenCalledWith('tok', record);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/demo/start');
		expect(JSON.parse(init.body as string)).toEqual({ lang: 'de' });
	});

	it.each([
		[429, 'Zu viele neue Demos'],
		[503, 'Die Demo ist gerade voll'],
		[500, 'konnte nicht starten']
	])('a %i is told in the visitor’s words', async (status, words) => {
		fetchMock.mockResolvedValue(new Response('{}', { status }));
		const err = await startDemo().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LocalizedError);
		expect((err as Error).message).toContain(words);
		expect(authStore.save).not.toHaveBeenCalled();
	});

	it('an unreachable server reads as a failed start, not a crash', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		await expect(startDemo()).rejects.toThrow('konnte nicht starten');
	});
});

describe('demoEndsAt', () => {
	it('is a day after the account was created, read from PocketBase’s date format', () => {
		authStore.record = { id: 'a1', created: '2026-10-06 12:00:00.000Z' };
		expect(demoEndsAt()).toBe(Date.parse('2026-10-07T12:00:00.000Z'));
	});

	it('is unknown without a record or a creation time', () => {
		expect(demoEndsAt()).toBeNull();
		authStore.record = { id: 'a1' };
		expect(demoEndsAt()).toBeNull();
	});
});

it('every typed example item has both names, and an aisle unless it is the hand-typed one', () => {
	const items = EXAMPLE_LISTS.flatMap((list) => list.items).flatMap((item) =>
		'slug' in item ? [item] : []
	);
	for (const item of items) {
		expect(item.de && item.en).toBeTruthy();
	}
	expect(items.filter((item) => item.slug === null)).toHaveLength(1);
});

it('every scanned example product is one the demo server stores, photo and all', () => {
	const barcodes = EXAMPLE_LISTS.flatMap((list) => list.items).flatMap((item) =>
		'barcode' in item ? [item.barcode] : []
	);
	expect(barcodes.length).toBeGreaterThan(0);
	for (const barcode of barcodes) {
		const photo = new URL(
			`../../../../backend/internal/demo/products/${barcode}.jpg`,
			import.meta.url
		);
		expect(existsSync(photo), barcode).toBe(true);
	}
});

it('the normal build’s #demo is inert', () => {
	expect(demo).toEqual({ enabled: false, Start: null, Banner: null, SignOut: null });
});
