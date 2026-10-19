// The one way every view reads Dexie (§9.3): `live()` bridges liveQuery's
// Observable to Svelte's store contract and supplies an initial value.
//
// Cache generations ([D-145]): a module-level store replays its last value to
// its next first subscriber, which within one account is the point (a pref
// renders right on the first frame). Across a sign-out it would show the
// previous account's rows, so `wipeLocalAccountData` calls
// `invalidateLiveCaches()` and a store restarting under a newer generation
// begins from `initial`, unloaded.
//
// Preloaded first frames ([D-205]): `preload()` runs keyed queries in a route's
// `load`, and a store whose key has a preloaded value starts from it, loaded.
// The liveQuery owns every value after that.
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';

/**
 * A live store, plus whether its first emission has landed. An empty state must
 * read `loaded`: the `initial` value looks like a real empty result, and the
 * home would flash its onboarding screen for a user with a dozen lists.
 */
export interface LiveStore<T> extends Readable<T> {
	loaded: Readable<boolean>;
	/** The query's identity, when it has one — what `preload()` reads. */
	readonly key?: string;
	/** @internal Runs the query once, outside any subscription. */
	readonly read: () => Promise<T>;
}

let cacheGeneration = 0;

/**
 * Values by query key, current generation only: written by `preload()` and by
 * every emission of a keyed store, so a later store for the same query starts
 * from the newest value.
 */
const seeds = new Map<string, unknown>();

/**
 * Marks every live store's cached value as predating a wipe of local account
 * data, so an unsubscribed store restarts from `initial`. Called by
 * `wipeLocalAccountData`.
 */
export function invalidateLiveCaches(): void {
	cacheGeneration++;
	seeds.clear();
}

/**
 * Read the given keyed stores' queries now, so each starts loaded ([D-205]). A
 * failed query is left unseeded, and a wipe while the reads are out discards
 * them.
 */
export async function preload(stores: LiveStore<unknown>[]): Promise<void> {
	const generation = cacheGeneration;
	await Promise.all(
		stores.map(async (store) => {
			if (store.key === undefined) throw new Error('preload: a store without a key');
			try {
				const value = await store.read();
				if (generation === cacheGeneration) seeds.set(store.key, value);
			} catch {
				// The store's own subscription reports it.
			}
		})
	);
}

export function live<T>(query: () => Promise<T>, initial: T, key?: string): LiveStore<T> {
	let valueGeneration = cacheGeneration;
	// One source for both stores, so they cannot disagree and share one
	// liveQuery subscription.
	const source = readable<{ value: T; loaded: boolean }>(
		{ value: initial, loaded: false },
		(set) => {
			// Runs before the first subscriber gets a value, so a stale cache is
			// never seen.
			if (key !== undefined && seeds.has(key)) {
				valueGeneration = cacheGeneration;
				set({ value: seeds.get(key) as T, loaded: true });
			} else if (valueGeneration !== cacheGeneration) {
				valueGeneration = cacheGeneration;
				set({ value: initial, loaded: false });
			}
			const subscription = liveQuery(query).subscribe({
				next: (value) => {
					valueGeneration = cacheGeneration;
					if (key !== undefined) seeds.set(key, value);
					set({ value, loaded: true });
				},
				// A failing view query must not take the app down (e.g. mid-upgrade).
				error: (error) => console.error('liveQuery failed', error)
			});
			return () => subscription.unsubscribe();
		}
	);

	const value = derived(source, (state) => state.value);
	return {
		subscribe: value.subscribe,
		loaded: derived(source, (state) => state.loaded),
		key,
		read: query
	};
}
