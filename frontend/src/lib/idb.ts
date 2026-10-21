// The single-key IndexedDB store backing the PocketBase SDK's async auth store
// (§5.6).
//
// THE SCHEMA HERE IS NOT FREE TO CHANGE. It must keep opening the database
// devices already hold (first created through raw IndexedDB), or every
// signed-in device silently loses its token. Load-bearing: the name
// `einkaufsliste` (a different database from db.ts's `einkaufsliste_sync`; do
// not merge them), version 1, and `kv: ''`, a store with no keyPath (keys are
// outbound, hence `put(value, key)`). idb.test.ts writes through the raw path
// and reads back through this module.
//
// ONE-WAY: Dexie opens `version(1)` as IndexedDB version 10, so a raw-IndexedDB
// build opening at version 1 would hit a VersionError and sign everyone out.
import Dexie from 'dexie';
import { reportUncaught } from '#lib/client-errors.js';

const STORE = 'kv';

// Bound to the global IndexedDB for the same reason as db.ts: otherwise the
// two integration-harness clients would share one auth token.
const db = new Dexie('einkaufsliste', {
	indexedDB: globalThis.indexedDB ?? Dexie.dependencies.indexedDB,
	IDBKeyRange: globalThis.IDBKeyRange ?? Dexie.dependencies.IDBKeyRange
});
db.version(1).stores({ [STORE]: '' });

const kv = db.table<string, string>(STORE);

/** The stored value, or '' for a missing key OR any failure to read one. */
export async function idbGet(key: string): Promise<string> {
	// Never throws: awaited on boot (pb.ts's `initialToken`), where an unreadable
	// store means "not signed in", not "fail to start".
	// Reported, though: a store that cannot be read signs the user out at
	// every launch with no reason given.
	try {
		return (await kv.get(key)) ?? '';
	} catch (error) {
		reportUncaught(error, 'session storage');
		return '';
	}
}

export async function idbSet(key: string, value: string): Promise<void> {
	// Swallows failures: the PocketBase AsyncAuthStore treats a rejecting save()
	// as a fatal unhandled rejection.
	// Reported: the next launch would be signed out with no reason given.
	try {
		await kv.put(value, key);
	} catch (error) {
		reportUncaught(error, 'session storage');
	}
}

export async function idbDel(key: string): Promise<void> {
	// Reported: the sign-out would not outlast a reload.
	try {
		await kv.delete(key);
	} catch (error) {
		reportUncaught(error, 'session storage');
	}
}
