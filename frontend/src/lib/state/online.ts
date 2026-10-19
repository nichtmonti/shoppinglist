// Connectivity, as a store: disables the online-only affordances (§9.3) and
// picks the §12.1 chip's offline state. `navigator.onLine` is a hint, not
// proof, which is enough for both; nothing in the sync engine gates on it.
import { readable } from 'svelte/store';

export const online = readable(globalThis.navigator?.onLine ?? true, (set) => {
	const up = () => set(true);
	const down = () => set(false);
	globalThis.addEventListener?.('online', up);
	globalThis.addEventListener?.('offline', down);
	return () => {
		globalThis.removeEventListener?.('online', up);
		globalThis.removeEventListener?.('offline', down);
	};
});

export function isOnline(): boolean {
	return globalThis.navigator?.onLine ?? true;
}
