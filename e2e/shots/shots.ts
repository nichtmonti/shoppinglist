import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';

// What the screenshot configs share: where the images go, the phone they are
// taken on, the app's own copy in either locale, and the steps both stories
// take.
//
// scripts/shots.sh is the way to run them; it sets SHOTS_OUT. Run by hand,
// images land in e2e/shots/out/ (gitignored).

const REPO = resolve(import.meta.dirname, '../..');

export const OUT = resolve(process.env.SHOTS_OUT ?? resolve(import.meta.dirname, 'out'));

/** A mid-size phone (iPhone 14/15 class), at the density a README wants.
 *  isMobile gives overlay scrollbars: a desktop profile reserves a gutter. */
export const PHONE = {
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 2,
	isMobile: true,
	hasTouch: true
};

export type Locale = 'de' | 'en';
export type Theme = 'light' | 'dark';

const messages: Record<Locale, Record<string, string>> = {
	de: JSON.parse(readFileSync(resolve(REPO, 'frontend/messages/de.json'), 'utf8')),
	en: JSON.parse(readFileSync(resolve(REPO, 'frontend/messages/en.json'), 'utf8'))
};

/** The app's copy for `key` in `locale` — so one script drives both languages. */
export function msg(locale: Locale, key: string): string {
	const text = messages[locale][key];
	if (text === undefined) throw new Error(`no message "${key}" in ${locale}.json`);
	return text;
}

/** Waits for web fonts and every image — lazy ones made eager, since a
 *  preview taller than the viewport would otherwise show them unloaded —
 *  then saves `target` as OUT/<name>.png. */
export async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
	const path = resolve(OUT, `${name}.png`);
	mkdirSync(dirname(path), { recursive: true });
	await page.evaluate(async () => {
		await document.fonts.ready;
		const images = [...document.images];
		for (const img of images) img.loading = 'eager';
		const settled = (img: HTMLImageElement) =>
			new Promise((done) => {
				img.addEventListener('load', done, { once: true });
				img.addEventListener('error', done, { once: true });
			});
		const loaded = Promise.all(images.filter((img) => !img.complete).map(settled));
		await Promise.race([loaded, new Promise((done) => setTimeout(done, 10_000))]);
	});
	await target.screenshot({ path, animations: 'disabled', caret: 'hide' });
}

const BROWSER_LOCALE: Record<Locale, string> = { en: 'en-US', de: 'de-DE' };

let client = 0;
/** A fresh phone in `locale` (its browser language picks the app's), as its
 *  own person: its own client IP, since PocketBase allows two sign-ins per
 *  3s per address. */
export async function device(browser: Browser, locale: Locale, theme: Theme) {
	client += 1;
	const context = await browser.newContext({
		...PHONE,
		locale: BROWSER_LOCALE[locale],
		colorScheme: theme,
		extraHTTPHeaders: { 'X-Forwarded-For': `10.9.${client >> 8}.${client & 255}` }
	});
	return { context, page: await context.newPage() };
}

/** Lets layout, transitions and the live queries settle before a shot. */
export const settle = (page: Page) => page.waitForTimeout(600);

/** Creates a passkey account on the auth screen already open on `page`. */
export async function createAccount(page: Page, locale: Locale, nickname: string): Promise<void> {
	await page.getByLabel(msg(locale, 'auth_nickname_label'), { exact: true }).fill(nickname);
	await page.getByRole('button', { name: msg(locale, 'auth_create_account') }).click();
}

export async function createList(page: Page, locale: Locale, name: string): Promise<void> {
	await page
		.getByRole('button', { name: msg(locale, 'home_new_list') })
		.first()
		.click();
	const dialog = page.getByRole('dialog', { name: msg(locale, 'home_new_list') });
	await dialog.getByLabel(msg(locale, 'home_new_list_prompt')).fill(name);
	await dialog.getByRole('button', { name: msg(locale, 'home_new_list') }).click();
	await expect(page).toHaveURL(/\/list\/[^/]+$/);
}
