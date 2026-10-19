// Every screen's code, imported once the first screen is up ([D-202]), so a
// later tap imports nothing: on iOS a route's dynamic import can fail after
// the service worker slept, and [D-298]'s way past the worker is Chromium's
// alone. Only under the worker, whose precache holds the chunks: without one
// (a first visit) this would download every screen.
import { routes } from '$app/manifest';
import { preloadCode } from '$app/navigation';

export async function preloadScreens(): Promise<void> {
	if (!navigator.serviceWorker?.controller) return;
	await Promise.all(
		routes
			.filter((route) => route.page)
			// A failed preload leaves that screen to load on its tap, as before.
			.map((route) => preloadCode(route.id).catch(() => {}))
	);
}
