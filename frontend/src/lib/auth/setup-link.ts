// The setup link of an invite-only instance with no account yet ([D-241]):
// `<origin>/#setup=<token>`, printed to the server log at boot.
//
// The token is read once and the fragment removed, as JoinScreen does with an
// invite (§7.1), so it stays out of history; the tab keeps it for a reload
// ([D-292]).
import { replaceOwnUrl } from '../history-layers.svelte';
import { page } from '$app/state';
import { tabValue } from '../safe-storage';

const PREFIX = '#setup=';

const stored = tabValue('setup-token');

/** The setup token this tab was opened with, or null. */
export function setupToken(): string | null {
	if (typeof location !== 'undefined' && location.hash.startsWith(PREFIX)) {
		const token = location.hash.slice(PREFIX.length);
		// Through the router: `page.url` would keep the token otherwise.
		void replaceOwnUrl(location.pathname + location.search, page.state);
		if (token) stored.set(token);
		return token || null;
	}
	return stored.get();
}

/** Forget the token once it has made an account: it admits only one. */
export function clearSetupToken(): void {
	stored.clear();
}
