// The demo's way in ([D-234]): what a refused start tells the visitor, what a
// successful one stores, and when the banner says the account goes.
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted(() => ({
	isValid: false,
	token: '',
	record: null as { id: string; created?: string } | null,
	onChange: vi.fn(),
	save: vi.fn(),
	clear: vi.fn()
}));

const send = vi.hoisted(() => vi.fn());

vi.mock('#lib/pb.js', async () =>
	(await import('#lib/test-kit/pb-mock.js')).pbModuleMock({ authStore, send })
);

import { EXAMPLE_LISTS, demoEndsAt, startDemo } from './start';
import { demo } from './off';
import { setLocale } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';
import { ClientResponseError } from 'pocketbase';

beforeEach(() => {
	setLocale('de');
	authStore.record = null;
	authStore.save.mockReset();
	send.mockReset();
});

describe('startDemo', () => {
	it('stores the session the server answers with, and says which language to name it in', async () => {
		const record = { id: 'a1', nickname: 'Gast 1234' };
		send.mockResolvedValue({ token: 'tok', record });
		await startDemo();
		expect(authStore.save).toHaveBeenCalledWith('tok', record);
		expect(send).toHaveBeenCalledWith('/api/demo/start', { method: 'POST', body: { lang: 'de' } });
	});

	it.each([
		[429, 'Zu viele neue Demos'],
		[503, 'Die Demo ist gerade voll'],
		[500, 'konnte nicht starten']
	])('a %i is told in the visitor’s words', async (status, words) => {
		send.mockRejectedValue(new ClientResponseError({ status }));
		const err = await startDemo().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LocalizedError);
		expect((err as Error).message).toContain(words);
		expect(authStore.save).not.toHaveBeenCalled();
	});

	it('an unreachable server reads as a failed start, not a crash', async () => {
		// The SDK's answer when no response came: status 0.
		send.mockRejectedValue(new ClientResponseError({ status: 0 }));
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
