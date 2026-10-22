import { expect, test, type Page } from './fixtures';
import {
	addItemByTyping,
	createList,
	FAKE_BARCODE,
	openListView,
	openShopView,
	registerAccount,
	showInviteLink,
	stubBarcodeLookup
} from './helpers';
import { aimCamera, installCamera } from './camera';

// §10 CSP. The policy is authored in frontend/vite.config.ts, baked into
// index.html as a <meta> tag by the SvelteKit build, and mirrored into a
// response header by backend/internal/security. This suite is what makes that
// arrangement safe to have:
//
//  1. Nothing the app legitimately does is blocked. A CSP failure is a runtime
//     failure with no build-time or type-level warning, so the only way to know
//     is to drive the real flows against the real policy and watch the console.
//     The e2e harness (server.ts) serves the real binary with its SPA
//     embedded, so what runs here is exactly what a deploy serves.
//  2. The header and the meta tag say the same thing. A browser enforces both
//     INDEPENDENTLY — a resource must satisfy each — so any drift between them
//     silently intersects into a policy nobody wrote.

/** Every CSP complaint the browser made, in the order it made them. */
function collectViolations(page: Page): string[] {
	const violations: string[] = [];
	page.on('console', (msg) => {
		const text = msg.text();
		if (/content security policy/i.test(text)) violations.push(text);
	});
	// A blocked inline handler or a blocked eval surfaces here rather than (or
	// as well as) on the console.
	page.on('pageerror', (err) => {
		if (/content security policy/i.test(err.message)) violations.push(err.message);
	});
	return violations;
}

test('CSP: the app runs its real flows without a single policy violation', async ({ browser }) => {
	const context = await browser.newContext();
	await stubBarcodeLookup(context);
	const page = await context.newPage();
	const violations = collectViolations(page);
	await installCamera(page, FAKE_BARCODE);

	// 1. Cold boot + passkey registration: the inline bootstrap <script> the
	//    meta tag's sha256 covers, the module graph under script-src, and the
	//    connect-src calls the sign-up makes.
	await registerAccount(page, 'Cora');
	await createList(page, 'CSP-Liste');
	await openListView(page);

	// 2. A typed item: auto-categorisation renders the `style={…}` attribute
	//    bindings style-src-attr exists for.
	await addItemByTyping(page, 'Milch');
	await expect(page.locator('[data-testid="row"]', { hasText: 'Milch' })).toBeVisible({
		timeout: 10_000
	});

	// 3. The scan pipeline: 'wasm-unsafe-eval' plus the self-hosted .wasm fetch,
	//    then the same-origin proxy call under connect-src 'self'. The product
	//    image renders on a shop tile under img-src.
	await page.locator('[data-testid="scan-trigger"]').click();
	await aimCamera(page);
	await expect(
		page.locator('[data-testid="row"]', { hasText: 'Testprodukt Sonnencreme' })
	).toBeVisible({
		timeout: 15_000
	});
	await openShopView(page);
	const scannedTile = page.locator('[data-testid="tile"]', { hasText: 'Testprodukt Sonnencreme' });
	await expect(scannedTile).toBeVisible();
	await expect(async () => {
		const naturalWidth = await scannedTile
			.locator('[data-testid="tile-photo"]')
			.evaluate((img: HTMLImageElement) => img.naturalWidth);
		expect(naturalWidth).toBeGreaterThan(0);
	}).toPass({ timeout: 10_000 });

	// 4. The share sheet's QR code: an {@html} SVG blob, the one place the app
	//    injects markup at runtime. A new list has no link until one is
	//    created ([D-330]).
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	await showInviteLink(page);
	await page.getByRole('tab', { name: 'QR', exact: true }).click();
	await expect(page.locator('[data-testid="qr"] svg')).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Escape');

	// 5. The service worker serving the cached shell — worker-src, and the
	//    precached assets coming back through it rather than off the network.
	await page.evaluate(() => navigator.serviceWorker.ready);
	await context.setOffline(true);
	// Waited for from before the reload (pwa.spec.ts).
	const reloaded = page.waitForEvent('load');
	await page.evaluate(() => location.reload());
	await reloaded;
	await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 15_000 });
	await context.setOffline(false);

	expect(violations).toEqual([]);

	await context.close();
});

test('CSP: the response header and the index.html meta tag carry the same policy', async ({
	page,
	request,
	baseURL
}) => {
	const response = await request.get(`${baseURL}/`);
	const header = response.headers()['content-security-policy'];
	expect(header, 'no CSP header — did the build run, and did it emit the meta tag?').toBeTruthy();

	await page.goto('/');
	const meta = await page
		.locator('meta[http-equiv="content-security-policy" i]')
		.getAttribute('content');
	expect(meta, 'no CSP meta tag in index.html — check kit.csp in vite.config.ts').toBeTruthy();

	// The header is the meta policy verbatim, plus the one directive a meta CSP
	// cannot express (SvelteKit strips frame-ancestors from meta output).
	expect(header).toBe(`${meta}; frame-ancestors 'none'`);

	// Every directive and its exact sources, so that dropping one breaks here
	// rather than in the field, and so does widening one ('unsafe-inline' or a
	// host added to script-src for a library). Only the build's hashes vary.
	const policy = Object.fromEntries(
		header.split(';').map((d) => {
			const [name, ...sources] = d.trim().split(/\s+/);
			return [name, sources.filter((s) => !s.startsWith("'sha256-"))];
		})
	);
	expect(policy).toEqual({
		'default-src': ["'self'"],
		'frame-src': ["'none'"],
		'worker-src': ["'self'"],
		'connect-src': ["'self'"],
		'img-src': ["'self'", 'data:'],
		'manifest-src': ["'self'"],
		'object-src': ["'none'"],
		'script-src': ["'self'", "'wasm-unsafe-eval'"],
		'style-src': ["'self'"],
		'style-src-attr': ["'unsafe-inline'"],
		'base-uri': ["'none'"],
		'form-action': ["'self'"],
		'frame-ancestors': ["'none'"]
	});

	// A non-document response is exactly what the header exists for — the meta
	// tag cannot reach it.
	const api = await request.get(`${baseURL}/api/health`);
	expect(api.headers()['content-security-policy']).toBe(header);
	expect(api.headers()['permissions-policy']).toContain('publickey-credentials-get=(self)');

	// PocketBase's dashboard keeps PocketBase's own, fuller policy.
	const dashboard = (await request.get(`${baseURL}/_/`)).headers()['content-security-policy'];
	expect(dashboard).not.toBe(header);
	expect(dashboard).toContain("script-src 'self'");
	expect(dashboard).toContain("frame-ancestors 'none'");
});
