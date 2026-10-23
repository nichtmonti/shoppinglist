// [D-197] A client-side failure shows the app's error page — with the error's
// own one-line description, not SvelteKit's bare "500 Internal Error" — and
// is reported to the server log.
// [D-202] A route whose CODE failed to load is retried as a full page
// load after a pause — at most twice a minute.
import { devices, expect, test, type Page } from './fixtures';
import { registerAccount, createList } from './helpers';

// The service worker serves cached route chunks, which page.route cannot see.
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

async function homeWithList(page: Page) {
	await registerAccount(page, 'Fehler');
	await createList(page, 'Wocheneinkauf');
	await page.goto('/');
	await page.reload();
	const card = page.getByRole('link', { name: /Wocheneinkauf/ }).first();
	await card.waitFor();
	return card;
}

test('a route whose code fails to load recovers with a full page load after a pause', async ({
	page
}) => {
	const card = await homeWithList(page);
	const report = page.waitForRequest((r) => r.url().endsWith('/api/client-errors'));
	// The route's code fails for this document and loads after a reload. One
	// failed request is not enough: Chromium 156 fetches a module again on the
	// next import() where 153 kept the failure, so the browser recovers a
	// single failure before the app sees it. [D-202] covers the rest.
	let reloaded = false;
	page.on('load', () => (reloaded = true));
	await page.route('**/_app/immutable/nodes/**', (route) =>
		reloaded ? route.continue() : route.abort()
	);
	await card.tap();

	await expect(page.getByRole('button', { name: 'Wocheneinkauf', exact: true })).toBeVisible({
		timeout: 15_000
	});
	await expect(page.locator('[role=alert].error-view')).toHaveCount(0);
	const sent = JSON.parse((await report).postData() ?? '{}') as { context?: string };
	expect(sent.context).toContain('recovery=reload-1500ms');
});

test('a route that keeps failing shows the error page and is reported, without looping', async ({
	page
}) => {
	const card = await homeWithList(page);
	const report = page.waitForRequest((r) => r.url().endsWith('/api/client-errors'));
	// The third failure's report: the guard refused a third retry.
	const lastReport = page.waitForRequest(
		(r) => r.url().endsWith('/api/client-errors') && (r.postData() ?? '').includes('recovery=none')
	);
	let loads = 0;
	page.on('load', () => loads++);
	// Every route chunk but SvelteKit's root layout (node 0) and error page
	// (node 1), which the page needs to boot and to say what went wrong.
	await page.route('**/_app/immutable/nodes/**', (route) =>
		/\/nodes\/[01]\./.test(route.request().url()) ? route.continue() : route.abort()
	);
	await card.tap();

	// While a retry is pending the page says only that it is on it…
	await expect(page.getByTestId('error-retrying')).toContainText('Einen Moment');
	// …and after the second retry fails too, the error page stays.
	const alert = page.locator('[role=alert].error-view');
	await expect(alert).toContainText('Etwas ist schiefgelaufen.', { timeout: 20_000 });
	await expect(page.getByTestId('error-detail')).toContainText('TypeError');
	await expect(alert.getByRole('button', { name: 'Neu laden' })).toBeVisible();
	const sent = JSON.parse((await report).postData() ?? '{}') as { message?: string };
	expect(sent).toMatchObject({ route: '/list/[id]', status: 500 });
	expect(sent.message).toContain('TypeError');
	// Two retries, then the guard holds: the last failure schedules no reload,
	// so there is no loop to wait for.
	await lastReport;
	await expect.poll(() => loads).toBe(2);
});
