import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { registerAccount } from './helpers';

// [D-346] A window still on the previous build reloads into the new one the
// next time it is hidden. SvelteKit asks /_app/version.json whenever the
// window is shown; the route answers as a deploy would.

/** The window as the browser hides or shows it. */
function setVisibility(page: Page, state: 'visible' | 'hidden') {
	return page.evaluate((value) => {
		Object.defineProperty(document, 'visibilityState', { value, configurable: true });
		document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
	}, state);
}

async function showWith(page: Page, version: string) {
	await page.route('**/_app/version.json', (route) => route.fulfill({ json: { version } }));
	const asked = page.waitForResponse('**/_app/version.json');
	await setVisibility(page, 'visible');
	await asked;
}

/** How the page's current document came to be: 'reload' after a reload. */
function navigationType(page: Page) {
	return page.evaluate(
		() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type
	);
}

test('a window on the previous build reloads once it is hidden', async ({ page }) => {
	await registerAccount(page, 'Ute');
	await showWith(page, 'a-newer-build');
	const reloaded = page.waitForEvent('load', { timeout: 15_000 });
	await setVisibility(page, 'hidden');
	await reloaded;
	expect(await navigationType(page)).toBe('reload');
});

test('a window hidden before its check has answered still reloads', async ({ page }) => {
	await registerAccount(page, 'Ute');
	let answer = () => {};
	const answered = new Promise<void>((resolve) => (answer = resolve));
	await page.route('**/_app/version.json', async (route) => {
		await answered;
		await route.fulfill({ json: { version: 'a-newer-build' } });
	});
	const asked = page.waitForRequest('**/_app/version.json');
	await setVisibility(page, 'visible');
	await asked;
	const reloaded = page.waitForEvent('load', { timeout: 15_000 });
	await setVisibility(page, 'hidden');
	answer();
	await reloaded;
	expect(await navigationType(page)).toBe('reload');
});

test('a window on the current build stays as it is when hidden', async ({ page }) => {
	await registerAccount(page, 'Ute');
	const current = await page.evaluate(() =>
		fetch('/_app/version.json').then((r) => r.json() as Promise<{ version: string }>)
	);
	await showWith(page, current.version);
	let loads = 0;
	page.on('load', () => loads++);
	await setVisibility(page, 'hidden');
	// eslint-disable-next-line playwright/no-wait-for-timeout -- an absence gets a window ([D-342])
	await page.waitForTimeout(2_000);
	expect(loads).toBe(0);
});
