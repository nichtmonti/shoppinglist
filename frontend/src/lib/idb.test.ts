// The auth-token store's ONE dangerous property: it must keep opening the
// database the pre-Dexie raw-IndexedDB version created. If the schema drifts,
// every already-signed-in device silently loses its token on upgrade and lands
// back on the auth screen — a bug no other test here would catch, because a
// fresh test database is compatible with anything.
//
// So the FIRST test writes a value the old way (raw indexedDB.open +
// createObjectStore('kv'), no keyPath) and reads it back through the module.
// Test order is load-bearing: Dexie labels `version(1)` as IndexedDB version 10
// (it scales by 10 to leave room for its own intermediate upgrades), so once any
// Dexie call in this file has opened the database, a raw open at version 1
// fails with VersionError. That is the correct direction — real devices have the
// v1 database first and Dexie upgrades it — but it means the compat test cannot
// run after the others, and cannot share a beforeEach that touches the store.
import { describe, expect, it } from 'vitest';
import { idbDel, idbGet, idbSet } from './idb';

const DB_NAME = 'einkaufsliste';

/** The exact schema + write path the raw implementation used. */
function rawPut(key: string, value: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
		};
		req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction('kv', 'readwrite');
			tx.objectStore('kv').put(value, key);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error ?? new Error('raw put failed'));
		};
	});
}

describe('idb (§5.6 auth token store)', () => {
	it('reads a token written by the raw pre-Dexie implementation', async () => {
		await rawPut('legacy', 'token-from-the-old-schema');
		expect(await idbGet('legacy')).toBe('token-from-the-old-schema');
	});

	it('round-trips a value', async () => {
		await idbSet('pb_auth', 'jwt');
		expect(await idbGet('pb_auth')).toBe('jwt');
	});

	it('returns the empty string for a missing key', async () => {
		expect(await idbGet('never-written')).toBe('');
	});

	it('deletes', async () => {
		await idbSet('doomed', 'jwt');
		await idbDel('doomed');
		expect(await idbGet('doomed')).toBe('');
	});

	// NOT TESTED, deliberately: idbGet's "any failure reads as not signed in"
	// catch. The cases that trigger it are a failed open or read — quota
	// exhaustion, a corrupt store, a private-mode restriction — and none are
	// reachable from here. Dexie captures the IndexedDB factory when the module
	// constructs its instance, so breaking `globalThis.indexedDB` afterwards has
	// no effect on the already-open connection (an earlier draft of this file
	// asserted exactly that and passed for the wrong reason).
});
