// A route whose code fails to load ([D-202]): iOS Safari, under a
// service worker, can fail a module load transiently, and an immediate reload
// fails the same way. So the navigation is retried as a full page load after a
// pause, at most twice per path per minute so it can never loop, and the report
// carries what the page can see of the failure.

/** Messages the three engines use for a module that could not be loaded. */
const MODULE_LOAD_ERROR =
	/Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS/i;

export function isModuleLoadError(message: string): boolean {
	return MODULE_LOAD_ERROR.test(message);
}

// Recent resource-load failures, newest last. An element's `error` does not
// bubble, hence a capturing listener on window.
const failed: string[] = [];
let watching = false;

export function watchResourceFailures(): void {
	if (watching || typeof window === 'undefined') return;
	watching = true;
	window.addEventListener(
		'error',
		(event) => {
			const target = event.target as { src?: string; href?: string; tagName?: string } | null;
			if (!target || target === (window as unknown)) return;
			const url = target.src || target.href;
			if (!url) return;
			failed.push(url);
			if (failed.length > 10) failed.shift();
		},
		true
	);
}

/** What the report adds for a module-load failure: which URLs, and who served them. */
export function moduleFailureContext(): string {
	const parts: string[] = [];
	const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
	parts.push(`sw=${sw?.controller ? 'controlled' : 'none'}`);
	if (failed.length > 0) parts.push(`failed=${failed.join(',')}`);
	try {
		// The app's own chunks that came back empty or as an error, where the
		// engine records it (responseStatus is recent).
		const bad = performance
			.getEntriesByType('resource')
			.filter((e): e is PerformanceResourceTiming => e.name.includes('/_app/'))
			.filter((e) => {
				const status = (e as PerformanceResourceTiming & { responseStatus?: number })
					.responseStatus;
				return (status !== undefined && status >= 400) || e.decodedBodySize === 0;
			})
			.slice(-5)
			.map((e) => {
				const status = (e as PerformanceResourceTiming & { responseStatus?: number })
					.responseStatus;
				return `${new URL(e.name).pathname}(${status ?? '?'},${e.decodedBodySize}b)`;
			});
		if (bad.length > 0) parts.push(`suspect=${bad.join(',')}`);
	} catch {
		/* no Performance API — the rest still helps */
	}
	return parts.join(' ');
}

const GUARD_PREFIX = 'shoppinglist-reload:';
const GUARD_MS = 60_000;
/** The pause before each retry. */
const RETRY_DELAYS_MS = [1_500, 5_000] as const;

/**
 * Claim the next full-page retry for `url`. Returns its delay in ms, or null
 * when both retries of the last minute are spent (the error page stays).
 */
export function claimReload(url: URL, now: number = Date.now()): number | null {
	const key = GUARD_PREFIX + url.pathname;
	try {
		const raw = sessionStorage.getItem(key);
		const prev = raw ? (JSON.parse(raw) as { first: number; count: number }) : null;
		const fresh = !prev || now - prev.first >= GUARD_MS;
		const count = fresh ? 0 : prev.count;
		if (count >= RETRY_DELAYS_MS.length) return null;
		sessionStorage.setItem(
			key,
			JSON.stringify({ first: fresh ? now : prev.first, count: count + 1 })
		);
		return RETRY_DELAYS_MS[count];
	} catch {
		// No sessionStorage (private mode quirks): without a guard, do not risk a loop.
		return null;
	}
}

let controllerChanges = 0;

/** Count service-worker takeovers from boot, for the report. */
export function watchServiceWorker(): void {
	if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
	navigator.serviceWorker.addEventListener('controllerchange', () => controllerChanges++);
}

/**
 * How long the service worker takes to answer from its cache (robots.txt is
 * precached), capped at `timeoutMs`: tests "the worker was asleep".
 */
export async function probeServiceWorker(timeoutMs = 1_200): Promise<string> {
	if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return 'none';
	const t0 = performance.now();
	try {
		await fetch('/robots.txt', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
		return `${Math.round(performance.now() - t0)}ms`;
	} catch (e) {
		return e instanceof DOMException && e.name === 'TimeoutError' ? `>${timeoutMs}ms` : 'error';
	}
}

/** The page-lifetime facts the report adds. */
export function pageContext(): string {
	const age = Math.round(performance.now() / 1000);
	return `pageAge=${age}s swChanges=${controllerChanges}`;
}
