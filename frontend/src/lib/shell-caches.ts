// Which app-shell caches an activating service worker deletes ([D-293]). A
// page still running the previous build loads its lazy chunks (the passkey
// library, the scanner, the QR code, the photo viewer) by that build's hashed
// paths, which the new shell does not have: the server would answer them
// with index.html. So the newest older shell stays until the next deploy.
//
// Also which strategy the worker answers a request with (routeOf).
import { PHOTO_PATH } from './photo-cache';

const PREFIX = 'shell-';

/** The cache name of a build's shell. */
export function shellCache(version: string): string {
	return PREFIX + version;
}

/**
 * The caches to delete: every shell but `current` and the newest older one,
 * by the build version SvelteKit stamps (a timestamp); every other cache but
 * those in `keep`.
 */
export function staleCaches(keys: string[], current: string, keep: string[]): string[] {
	const older = keys
		.filter((key) => key.startsWith(PREFIX) && key !== current)
		.sort((a, b) => Number(b.slice(PREFIX.length)) - Number(a.slice(PREFIX.length)));
	const previous = older[0];
	return keys.filter((key) => key !== current && key !== previous && !keep.includes(key));
}

/** How the service worker answers a request; null passes it to the network
 *  untouched. */
export type Route = 'share-target' | 'navigation' | 'photo' | 'previous-build' | 'shell' | null;

/**
 * The strategy for a GET request. `scope` is the worker's scope, which the
 * manifest's paths are relative to; `assets` holds the absolute pathnames of
 * this build's shell. Only our own hash-named build and static files are
 * served from the shell: everything else on the origin (in particular /api/*)
 * and every cross-origin request passes through.
 */
export function routeOf(
	url: URL,
	mode: RequestMode,
	scope: URL,
	assets: ReadonlySet<string>
): Route {
	if (mode === 'navigate') {
		// The manifest's share_target action, with a list in its query ([D-254]).
		const shareTarget = new URL('import', scope).pathname;
		return url.pathname === shareTarget && url.search ? 'share-target' : 'navigation';
	}
	if (url.origin !== scope.origin) return null;
	if (url.pathname.startsWith(PHOTO_PATH)) return 'photo';
	if (assets.has(url.pathname)) return 'shell';
	// Another build's chunk ([D-293]).
	if (url.pathname.startsWith(new URL('_app/immutable/', scope).pathname)) {
		return 'previous-build';
	}
	return null;
}
