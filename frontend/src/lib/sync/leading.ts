// Whether this tab leads (§8.7): only the leader sends, so the status tells a
// stuck leader here from one in another tab ([D-296]). Written by the loop
// (mount.ts); false without one.
import { readonly, writable } from 'svelte/store';

const store = writable(false);

export const leading = readonly(store);

export function setLeading(value: boolean): void {
	store.set(value);
}
