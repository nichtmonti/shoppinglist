import { expect, test } from './fixtures';

// The app shell loads with the network disabled from a cold start, and
// Chromium reports the app installable. A truly-never-visited device
// can't load anything offline — no service worker has installed yet to serve
// from — so "cold start" here means what it does for every real PWA: one
// online visit installs + activates the worker and its precache
// (frontend/src/service-worker/index.ts), and every visit after that, including a full
// reload with no network at all, boots the app shell from that cache alone.
//
// No `lighthouse` package is vendored (this is a single self-hosted binary
// project, not one wired for third-party CI tooling) — Chromium's own
// `Page.getInstallabilityErrors` CDP method is the actual mechanism Lighthouse's
// PWA-installable audit queries, so asserting on it directly is the real
// check, not a stand-in for one.
test('PWA: app shell cold-starts with the network disabled, and Chromium reports it installable', async ({
	page,
	context
}) => {
	await page.goto('/');
	// `.ready` is the correct primitive here — it resolves once there IS an
	// active worker AND it has claimed this page (self.clients.claim() in the
	// activate handler), unlike polling getRegistration().active, which can
	// observe a registration that exists but hasn't claimed this client yet.
	await page.evaluate(() => navigator.serviceWorker.ready);

	const cdp = await context.newCDPSession(page);
	const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
	expect(installabilityErrors).toEqual([]);

	await context.setOffline(true);
	// Not page.reload() — Playwright/CDP's offline emulation can abort a
	// CDP-driven Page.reload() at the network layer before the active service
	// worker gets a chance to intercept it. A same-page `location.reload()`
	// goes through the renderer's normal navigation/fetch pipeline instead,
	// where the service worker DOES get first refusal — the real-world path an
	// actual offline reload takes.
	await page.evaluate(() => location.reload());
	await page.waitForLoadState('load');

	// The shell mounted — Svelte rendered *something* below the layout's own
	// markup — entirely from cache, with no network at all.
	await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 15_000 });
});

// [D-293] A server that is down behind a proxy answers navigations with its
// own error page, and a dead connection with nothing: either way the cached
// shell opens the app, whose lists are on the device.
for (const [what, answer] of [
	['answers 502', 'error'],
	['never answers', 'hang']
] as const) {
	test(`the app opens from its cached shell when the server ${what}`, async ({ page, context }) => {
		await page.goto('/');
		await page.evaluate(() => navigator.serviceWorker.ready);

		let routed = 0;
		await context.route(
			(url) => url.pathname === '/',
			async (route) => {
				routed++;
				if (answer === 'error') {
					await route.fulfill({ status: 502, contentType: 'text/html', body: 'Bad Gateway' });
				}
				// 'hang': never settled, as a connection that stalls.
			}
		);
		await page.evaluate(() => location.reload());

		await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('Bad Gateway')).toHaveCount(0);
		// The worker's own request met the route: the shell is what answered.
		expect(routed).toBeGreaterThan(0);
	});
}

// [D-298] The build's chunks come from the cache through the browser's static
// route, never through the worker: a worker stopped while a page loads aborts
// what it was answering, and a page whose boot chunk is aborted stays blank.
test('the build’s chunks are answered by the static route, not the worker', async ({
	page,
	context
}) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);

	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	const sources = new Map<string, string>();
	cdp.on('Network.responseReceived', ({ response }) => {
		const path = new URL(response.url).pathname;
		if (/^\/_app\/immutable\/.*\.(js|css)$/.test(path)) {
			sources.set(path, response.serviceWorkerRouterInfo?.actualSourceType ?? 'none');
		}
	});
	await page.reload();
	await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();

	expect(sources.size).toBeGreaterThan(0);
	expect([...sources].filter(([, source]) => source !== 'cache')).toEqual([]);
});

// [D-202] Under the worker, every screen's code is imported once the first
// screen is up, so a later tap imports nothing. The home alone loads two.
test('under the worker, every screen’s code loads once the first screen is up', async ({
	page
}) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();

	const nodes = () =>
		page.evaluate(
			() =>
				new Set(
					performance
						.getEntriesByType('resource')
						.map((entry) => new URL(entry.name).pathname)
						.filter((path) => path.startsWith('/_app/immutable/nodes/'))
				).size
		);
	await expect.poll(nodes).toBeGreaterThanOrEqual(8);
});

// The icons are in the shell the server sends, not added by the app
// once its JS has run — so a bookmark, the history and an iOS home-screen
// install see them — and each one the shell names is served as an image.
test('the app shell names its tab and home-screen icons, and the server serves each one', async ({
	request
}) => {
	const shell = await (await request.get('/')).text();
	const icons = [
		['icon', '/favicon.ico', 'image/'],
		['icon', '/favicon.svg', 'image/svg+xml'],
		['apple-touch-icon', '/apple-touch-icon.png', 'image/png']
	];
	for (const [rel, href, type] of icons) {
		expect(shell).toMatch(new RegExp(`<link rel="${rel}" href="\\.?${href.replace('.', '\\.')}"`));
		const res = await request.get(href);
		expect(res.status(), href).toBe(200);
		expect(res.headers()['content-type'], href).toContain(type);
	}
});
