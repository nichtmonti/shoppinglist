// App-shell precache (docs/internals/design.md §2 "PWA shell", §12). SvelteKit
// registers this itself (as a module service worker) — no manual
// navigator.serviceWorker.register() call needed.
//
// Scope is deliberately narrow: precache the built shell (JS/CSS — the
// `immutable` build output, minus the zxing .wasm below) plus the static/
// directory (`assets`) and the SPA fallback document, so a cold start with the
// network disabled still boots the app. Nothing else is cached: API responses
// stay out of this cache entirely — the sync engine already owns offline data
// via IndexedDB (§8), and caching auth-bearing API responses here would be a
// second, competing (and unscoped-per-account) source of truth.
import { self } from '$app/service-worker';
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { PHOTO_CACHE } from '#lib/photo-cache.js';
import { routeOf, shellCache, staleCaches, type Route } from '#lib/shell-caches.js';

const CACHE = shellCache(version);
// The manifest's paths are relative to the app's base, which is this
// worker's scope; requests and the cache compare absolute pathnames.
const scope = new URL(self.registration.scope);
const pathname = (path: string): string => new URL(path, scope).pathname;
// adapter-static's `fallback: 'index.html'` (vite.config.ts) is what the SPA
// boots from on any direct/offline navigation — precache it under the scope's
// root (`/`, its serving path), not `/index.html`, since that's the URL
// navigations resolve to and the one `navigation()` below falls back to.
const SHELL = scope.pathname;
const ASSETS = new Set([...[...immutable, ...assets].map(({ path }) => pathname(path)), SHELL]);
// The 1MB zxing reader binary is the ONE build asset kept out of the install
// precache: every non-scanning user paid it on the login screen for nothing.
// It stays in ASSETS, so the fetch handler still serves it cache-first once
// the first scan session has fetched it — offline decode keeps working from
// then on ([D-21]'s promise is "offline-capable", not "pre-installed").
const PRECACHE = [...ASSETS].filter((p) => !p.endsWith('.wasm'));
// How long a navigation waits on the network before the cached shell answers
// ([D-293]): a connection that hangs must not leave a white screen.
const NAVIGATION_WAIT_MS = 3000;

// The browser answers the build's chunks from the cache itself: a worker
// stopped mid-load aborts what it answers ([D-298]). Not the .wasm (below).
interface RouterInstallEvent extends ExtendableEvent {
	addRoutes?(rules: { condition: { urlPattern: string }; source: 'cache' }[]): Promise<void>;
}
const ROUTED = ['js', 'css', 'woff2'].map((ext) => ({
	condition: { urlPattern: `${pathname('_app/immutable/')}*.${ext}` },
	source: 'cache' as const
}));

self.addEventListener('install', (event: RouterInstallEvent) => {
	event.waitUntil(
		(async () => {
			await event.addRoutes?.(ROUTED);
			const cache = await caches.open(CACHE);
			// Without `Vary: Origin`, or a module script's Origin misses the route.
			await Promise.all(
				PRECACHE.map(async (path) => {
					const response = await fetch(path);
					if (!response.ok) throw new Error(`precache ${path}: ${response.status}`);
					const headers = new Headers(response.headers);
					headers.delete('vary');
					await cache.put(path, new Response(response.body, { headers }));
				})
			);
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// The previous build's shell stays for pages still running it.
			for (const key of staleCaches(await caches.keys(), CACHE, [PHOTO_CACHE])) {
				await caches.delete(key);
			}
			await self.clients.claim();
		})()
	);
});

const cachedShell = async (): Promise<Response | undefined> =>
	(await caches.open(CACHE)).match(SHELL);

/** A shared list arrives in the share target's query ([D-254]): from the
 *  cache it never reaches the server, whose request log and a proxy's access
 *  log would otherwise keep the whole list. */
async function shareTarget(request: Request): Promise<Response> {
	return (await cachedShell()) ?? navigation(request);
}

/** Navigations (cold start, deep link, reload) must resolve even fully
 *  offline — the client router then renders the right route from the single
 *  cached shell document. Also when the server is down behind a proxy (its
 *  502 page) or the network hangs: the lists are on the device ([D-293]). */
async function navigation(request: Request): Promise<Response> {
	const network = fetch(request);
	const shell = await cachedShell();
	if (!shell) return network;
	// Lost to the timeout or the shell, it may still reject.
	network.catch(() => {});
	const waited = new Promise<null>((resolve) =>
		setTimeout(() => resolve(null), NAVIGATION_WAIT_MS)
	);
	try {
		const response = await Promise.race([network, waited]);
		if (response && response.status < 500) return response;
	} catch {
		// offline: the shell below
	}
	return shell;
}

// Product photos, so a scanned item's picture survives offline (§9.2,
// [D-21]). Cache-first and never revalidated: the server rotates the token
// in the path whenever the bytes change, so a URL that resolves at all
// resolves to content that cannot change under it — the same reason the
// route sends `immutable`. With no cached copy and the network down, return
// an empty 504 rather than an undefined body; the <img> onerror fallback in
// ShopView renders the category emoji instead.
//
// Three properties this depends on, all of which come from photos being
// SAME-ORIGIN rather than fetched from the OFF/OBF CDN:
//
//  1. The worker's own fetch is allowed. A service worker inherits the CSP of
//     its script response, and inside a worker a photo fetch is governed by
//     connect-src, NOT img-src — so a cross-origin photo host would have to
//     be added to connect-src to be reachable from here at all.
//  2. `resp.ok` is meaningful. A cross-origin no-cors <img> request yields an
//     OPAQUE response (status 0, ok false), which would silently fail every
//     cache gate below and leave the cache permanently empty.
//  3. The e2e specs can serve it. Requests a service worker issues are not
//     interceptable by Playwright's context.route, so the specs seed a real
//     photo on the server rather than stub a CDN URL.
async function photo(request: Request): Promise<Response> {
	const cache = await caches.open(PHOTO_CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;
	const resp = await fetch(request).catch(() => undefined);
	if (resp && resp.ok) await cache.put(request, resp.clone());
	return resp ?? new Response('', { status: 504 });
}

/** A page still running the previous build asks for that build's hashed
 *  chunks, which only its shell cache holds ([D-293]); the server would answer
 *  them with index.html. */
async function previousBuild(request: Request, url: URL): Promise<Response> {
	return (await caches.match(url.pathname)) ?? fetch(request);
}

/** This build's hash-named build and static files: content-addressed, so
 *  safe to serve cache-first forever. */
async function shell(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(url.pathname);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) await cache.put(url.pathname, response.clone());
	return response;
}

const STRATEGIES: Record<NonNullable<Route>, (request: Request, url: URL) => Promise<Response>> = {
	'share-target': shareTarget,
	navigation,
	photo,
	'previous-build': previousBuild,
	shell
};

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	const route = routeOf(url, event.request.mode, scope, ASSETS);
	if (route) event.respondWith(STRATEGIES[route](event.request, url));
});
