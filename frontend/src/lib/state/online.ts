// Connectivity, as a store: disables the online-only affordances (§9.3) and
// picks the §12.1 chip's offline state. `navigator.onLine` is a hint, not
// proof, which is enough for both; nothing in the sync engine gates on it.
import { toStore } from 'svelte/store';
import { online as windowOnline } from 'svelte/reactivity/window';

// Svelte's reactive navigator.onLine, kept a store for the code that
// subscribes to it outside components.
export const online = toStore(() => windowOnline.current ?? true);

export function isOnline(): boolean {
	return globalThis.navigator?.onLine ?? true;
}
