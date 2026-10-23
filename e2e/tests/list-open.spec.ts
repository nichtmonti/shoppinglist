// [D-205] A list opens whole: its first painted frame already shows its name and
// every item — not the header first, then a busy placeholder, then the tiles,
// which on a phone reads as a flash on every open. Every store's first Dexie
// read has to land before the first render.
//
// The check records every animation frame while the list screen is on screen
// and compares each one with the settled screen, so an intermediate state
// fails even when it lasts a single frame.
import { expect, test, type Page } from './fixtures';
import {
	addItemByTyping,
	createList,
	openListView,
	openShopView,
	registerAccount
} from './helpers';

const ITEMS = ['Milch', 'Brot', 'Butter', 'Käse', 'Eier', 'Kaffee'];

interface Frame {
	title: string;
	tiles: number;
	busy: boolean;
}

/** Start recording every frame in which the list screen's header is on screen. */
async function recordFrames(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __frames: Frame[]; __recording: boolean };
		w.__frames = [];
		w.__recording = true;
		const tick = () => {
			if (!w.__recording) return;
			if (document.querySelector('[data-testid="view-toggle-shop"]')) {
				w.__frames.push({
					title: document.querySelector('h1')?.textContent?.trim() ?? '',
					tiles: document.querySelectorAll('[data-testid="tile"]').length,
					busy: document.querySelector('[aria-busy="true"]') !== null
				});
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

async function stopRecording(page: Page): Promise<Frame[]> {
	return page.evaluate(() => {
		const w = window as unknown as { __frames: Frame[]; __recording: boolean };
		w.__recording = false;
		return w.__frames;
	});
}

/** Every recorded frame shows the list as it ends up — named, full, not loading. */
function expectWhole(frames: Frame[], name: string) {
	expect(frames.length).toBeGreaterThan(0);
	const off = frames.filter((f) => f.title !== name || f.tiles !== ITEMS.length || f.busy);
	expect(off, `frames that were not the finished list`).toEqual([]);
}

test('a list opens whole: no frame without its name or its items', async ({ page }) => {
	await registerAccount(page, 'Flackern');
	await createList(page, 'Wocheneinkauf');
	await openListView(page);
	for (const name of ITEMS) {
		await addItemByTyping(page, name);
		await expect(page.locator('[data-testid="row"]', { hasText: name })).toBeVisible();
	}
	await openShopView(page);
	await expect(page.locator('[data-testid="tile"]')).toHaveCount(ITEMS.length);
	await page.goto('/');
	await createList(page, 'Baumarkt');

	// From the home screen, after a cold start — nothing read yet.
	await page.goto('/');
	await page.reload();
	const card = page.getByRole('link', { name: /Wocheneinkauf/ }).first();
	await card.waitFor();
	await recordFrames(page);
	await card.click();
	await expect(page.locator('[data-testid="tile"]')).toHaveCount(ITEMS.length);
	// eslint-disable-next-line playwright/no-wait-for-timeout -- the frames recorded meanwhile are the check
	await page.waitForTimeout(500);
	expectWhole(await stopRecording(page), 'Wocheneinkauf');

	// Back home and into the list again — the field report's path.
	await page.getByRole('button', { name: 'Zurück' }).click();
	await card.waitFor();
	await recordFrames(page);
	await card.click();
	await expect(page.locator('[data-testid="tile"]')).toHaveCount(ITEMS.length);
	// eslint-disable-next-line playwright/no-wait-for-timeout -- the frames recorded meanwhile are the check
	await page.waitForTimeout(500);
	expectWhole(await stopRecording(page), 'Wocheneinkauf');
});

test('the home screen starts whole after a cold start: no frame without its lists', async ({
	page
}) => {
	await registerAccount(page, 'Kaltstart');
	await createList(page, 'Wocheneinkauf');
	await page.goto('/');
	await createList(page, 'Baumarkt');
	await page.goto('/');
	await expect(page.getByRole('link', { name: /Baumarkt|Wocheneinkauf/ })).toHaveCount(2);

	// Recording from the document's first script on, through a reload.
	await page.addInitScript(() => {
		const w = window as unknown as { __frames: { cards: number; busy: boolean }[] };
		w.__frames = [];
		const tick = () => {
			// From the app's first painted state on: its busy placeholder or its heading.
			const busy = document.querySelector('[aria-busy="true"]') !== null;
			if (busy || document.querySelector('h1')?.textContent?.trim() === 'Meine Listen') {
				w.__frames.push({ cards: document.querySelectorAll('a[href*="/list/"]').length, busy });
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await page.reload();
	await expect(page.getByRole('link', { name: /Baumarkt|Wocheneinkauf/ })).toHaveCount(2);
	// eslint-disable-next-line playwright/no-wait-for-timeout -- the frames recorded meanwhile are the check
	await page.waitForTimeout(500);
	const frames = await page.evaluate(
		() => (window as unknown as { __frames: { cards: number; busy: boolean }[] }).__frames
	);
	const settled = await page.locator('a[href*="/list/"]').count();
	expect(settled).toBeGreaterThan(0);
	expect(frames.length).toBeGreaterThan(0);
	expect(frames.filter((f) => f.busy || f.cards !== settled)).toEqual([]);
});
