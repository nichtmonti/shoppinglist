// [D-205]: a store whose query a route preloaded starts from that value,
// loaded, so the screen's first frame is its finished one.
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '#lib/db.js';
import { wipeLocalAccountData } from '#lib/auth/account-data.js';
import { makeItem, putMyList, putSynced, resetDb } from '#lib/test-kit/db.js';
import { listMembership, listOpenItems, preloadList, preloadSettings } from './data';
import { invalidateLiveCaches, live, preload, type LiveStore } from './live';
import { listView } from './prefs';
import { suppressedNames } from './suppression';

/** The value and loaded flag a NEW first subscriber is handed synchronously. */
function firstRead<T>(store: LiveStore<T>): { value: T; loaded: boolean } {
	let value!: T;
	let loaded = false;
	const stopValue = store.subscribe((v) => (value = v));
	const stopLoaded = store.loaded.subscribe((l) => (loaded = l));
	stopValue();
	stopLoaded();
	return { value, loaded };
}

beforeEach(async () => {
	await resetDb();
	await putMyList('list-a', 'Wocheneinkauf');
	await putSynced([
		makeItem({ list: 'list-a', name: 'Milch' }),
		makeItem({ list: 'list-a', name: 'Brot' })
	]);
	await db.meta.put({ key: 'list_view', value: 'list' });
});

describe('preload', () => {
	it('hands a store built afterwards its value on the first read, loaded', async () => {
		expect(firstRead(listOpenItems('list-a'))).toEqual({ value: [], loaded: false });

		await preloadList('list-a');

		const items = firstRead(listOpenItems('list-a'));
		expect(items.loaded).toBe(true);
		expect(items.value.map((i) => i.name).sort()).toEqual(['Brot', 'Milch']);
		expect(firstRead(listMembership('list-a')).value?.name).toBe('Wocheneinkauf');
		expect(get(listView)).toBe('list');
	});

	it('settings: the hidden suggestions are there on the first read, not "none" for a frame', async () => {
		await db.meta.put({ key: 'suppressed_names', value: ['gurkenwasser'] });
		expect(firstRead(suppressedNames)).toEqual({ value: [], loaded: false });

		await preloadSettings();

		expect(firstRead(suppressedNames)).toEqual({ value: ['gurkenwasser'], loaded: true });
	});

	it('is per query: another list is not read by preloading this one', async () => {
		await preloadList('list-a');
		expect(firstRead(listOpenItems('list-b'))).toEqual({ value: [], loaded: false });
	});

	it('refuses a store without a key — it could never be found again', async () => {
		await expect(preload([live(async () => 1, 0)])).rejects.toThrow('without a key');
	});

	it('drops what it read when the account is wiped meanwhile', async () => {
		const reading = preloadList('list-a');
		await wipeLocalAccountData();
		await reading;
		expect(firstRead(listOpenItems('list-a'))).toEqual({ value: [], loaded: false });
	});

	it('drops a read that lands only after the wipe', async () => {
		// The read is still out when the caches are invalidated, so nothing
		// else clears what it hands back: only the generation check does.
		let land!: (rows: string[]) => void;
		const slow = live(() => new Promise<string[]>((resolve) => (land = resolve)), [], 'slow-read');
		const reading = preload([slow]);

		invalidateLiveCaches();
		land(['Milch vom vorigen Konto']);
		await reading;

		expect(firstRead(slow)).toEqual({ value: [], loaded: false });
	});
});
