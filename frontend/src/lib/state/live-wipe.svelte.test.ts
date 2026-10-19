// [D-145]: a module-level live store must not replay the previous account's
// rows after a sign-out. The wipe runs while nothing reads these stores (the
// auth screen subscribes to none of them), so without the invalidation the
// next account's first read would be the cached value — list names on the
// home screen included — until Dexie's first emission landed.
import { get, type Readable } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '#lib/db.js';
import { wipeLocalAccountData } from '#lib/auth/account-data.js';
import { putMyList, resetDb } from '#lib/test-kit/db.js';
import { lastSyncedAt, listIndex, memberships } from './data';
import type { LiveStore } from './live';
import { listOrder } from './prefs';
import { suppressedNames } from './suppression';

/** Subscribes until the first real emission has landed, then leaves. */
async function readThenLeave<T>(store: LiveStore<T> | Readable<T>): Promise<T> {
	const loaded = 'loaded' in store ? store.loaded : null;
	const stopValue = store.subscribe(() => {});
	const stopLoaded = loaded?.subscribe(() => {});
	await new Promise((r) => setTimeout(r, 50));
	const value = get(store);
	stopValue();
	stopLoaded?.();
	return value;
}

/** The value — and loaded flag — a NEW first subscriber is handed synchronously. */
function firstRead<T>(store: LiveStore<T> | Readable<T>): { value: T; loaded: boolean | null } {
	let value!: T;
	let loaded: boolean | null = null;
	const stopValue = store.subscribe((v) => (value = v));
	const stopLoaded = 'loaded' in store ? store.loaded.subscribe((l) => (loaded = l)) : undefined;
	stopValue();
	stopLoaded?.();
	return { value, loaded };
}

beforeEach(async () => {
	await resetDb();
	await putMyList('list-a', 'A’s list', { updated: '2026-09-01T00:00:00Z' });
	await db.meta.bulkPut([
		{ key: 'last_synced_at', value: '2026-09-26T10:00:00Z' },
		{ key: 'suppressed_names', value: ['gurkenwasser'] },
		{ key: 'list_order', value: ['list-a'] }
	] as never);
});

describe('module-level live stores across a sign-out', () => {
	it('start the next account from their initial value, not the wiped rows', async () => {
		const stores: Readable<unknown>[] = [
			memberships,
			listIndex,
			lastSyncedAt,
			suppressedNames,
			listOrder
		];
		// Account A reads every store once, as its screens would.
		for (const store of stores) expect(await readThenLeave(store)).toBeTruthy();

		await wipeLocalAccountData();

		expect(firstRead(memberships)).toEqual({ value: [], loaded: false });
		expect(firstRead(listIndex)).toEqual({ value: [], loaded: false });
		expect(firstRead(lastSyncedAt)).toEqual({ value: null, loaded: false });
		expect(firstRead(suppressedNames)).toEqual({ value: [], loaded: false });
		expect(firstRead(listOrder).value).toEqual([]);
	});

	it('still replay their cached value within one account (a pref renders right on frame one)', async () => {
		await readThenLeave(memberships);
		const again = firstRead(memberships);
		expect(again.loaded).toBe(true);
		expect(again.value.map((m) => m.name)).toEqual(['A’s list']);
	});
});
