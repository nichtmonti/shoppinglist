// The invite token this tab was opened with (§7.6). It stays in the address
// bar until the join ([D-295]): an in-app browser's „Open in Safari" and a
// copied address carry it on. The join replaces the entry, which takes it out
// of this tab's history. The tab also keeps it, for a reload ([D-292]).
import { tabValue } from '#lib/safe-storage.js';

const stored = tabValue('join-token');

/** The token in the fragment, else the one this tab read earlier. */
export function joinToken(): string {
	const fromUrl = typeof location !== 'undefined' ? location.hash.slice(1) : '';
	if (fromUrl) stored.set(fromUrl);
	return fromUrl || (stored.get() ?? '');
}

/** Forget the token once it has let this account in. */
export function clearJoinToken(): void {
	stored.clear();
}
