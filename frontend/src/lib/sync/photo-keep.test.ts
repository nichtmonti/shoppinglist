// [D-353] A synced item's photo is put into the photo cache after a cycle,
// whether or not a tile has shown it; the browser test (scan.spec.ts) proves
// it offline, this the bookkeeping around it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/db.js';
import { makeItem, resetDb } from '#lib/test-kit/db.js';
import { forgetKeptPhotos, keepPhotos, watchPhotos } from './photo-keep';

function fakeCaches(held: string[] = []) {
	const store = new Set(held);
	const cache = {
		match: vi.fn(async (url: string) => (store.has(url) ? new Response('') : undefined)),
		add: vi.fn(async (url: string) => {
			store.add(url);
		})
	};
	const open = vi.fn(async () => cache);
	vi.stubGlobal('caches', { open });
	return { cache, open, store };
}

beforeEach(async () => {
	await resetDb();
	forgetKeptPhotos();
});
afterEach(async () => {
	// A run still under way finishes against the fake before it goes.
	await keepPhotos();
	vi.unstubAllGlobals();
});

describe('keepPhotos', () => {
	it('puts each item photo the cache lacks into it, once', async () => {
		const { cache, store } = fakeCaches(['/api/barcode/photo/held']);
		await db.items.bulkPut([
			makeItem({ list: 'L', name: 'A', image_url: '/api/barcode/photo/new' }),
			makeItem({ list: 'L', name: 'B', image_url: '/api/barcode/photo/held' }),
			makeItem({ list: 'L', name: 'C', image_url: null })
		]);
		await keepPhotos();
		expect(cache.add.mock.calls).toEqual([['/api/barcode/photo/new']]);
		expect(store.has('/api/barcode/photo/new')).toBe(true);
		await keepPhotos();
		expect(cache.add).toHaveBeenCalledTimes(1);
	});

	it('does not open the cache when no item has a photo to keep', async () => {
		const { open } = fakeCaches();
		await db.items.put(makeItem({ list: 'L', name: 'A', image_url: null }));
		await keepPhotos();
		expect(open).not.toHaveBeenCalled();
	});

	it('asks again after a failed fetch', async () => {
		const { cache } = fakeCaches();
		cache.add.mockRejectedValueOnce(new TypeError('offline'));
		await db.items.put(makeItem({ list: 'L', name: 'A', image_url: '/api/barcode/photo/p' }));
		await keepPhotos();
		await keepPhotos();
		expect(cache.add).toHaveBeenCalledTimes(2);
	});

	it('stops a run a sign-out overtakes', async () => {
		const { cache, open } = fakeCaches();
		await db.items.put(makeItem({ list: 'L', name: 'A', image_url: '/api/barcode/photo/p' }));
		const run = keepPhotos();
		forgetKeptPhotos();
		await run;
		expect(open).not.toHaveBeenCalled();
		expect(cache.add).not.toHaveBeenCalled();
	});

	it('runs once more for a change that came in during a run', async () => {
		const { cache } = fakeCaches();
		await db.items.put(makeItem({ list: 'L', name: 'A', image_url: '/api/barcode/photo/a' }));
		const first = keepPhotos();
		await db.items.put(makeItem({ list: 'L', name: 'B', image_url: '/api/barcode/photo/b' }));
		const second = keepPhotos();
		await Promise.all([first, second]);
		expect(cache.add.mock.calls.flat().sort()).toEqual([
			'/api/barcode/photo/a',
			'/api/barcode/photo/b'
		]);
	});

	it('keeps a photo when an item with one is written, by whatever path', async () => {
		const { cache } = fakeCaches();
		const stop = watchPhotos();
		await db.items.put(makeItem({ list: 'L', name: 'A', image_url: '/api/barcode/photo/live' }));
		await vi.waitFor(() => expect(cache.add).toHaveBeenCalledWith('/api/barcode/photo/live'));
		stop();
	});
});
