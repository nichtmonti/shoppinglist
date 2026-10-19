import { expect, test } from '@playwright/test';
import { shoot } from './shots';

// Saves every preview of one or more gallery states. A state is the gallery's
// own query string (frontend/src/routes/dev/gallery/axes.ts) — the same URL
// its toolbar writes — so what you see in the browser is what you name here:
//
//   SHOTS_GALLERY='view=shop&density=compact,rows  compare=<id>&theme=light,dark'
//
// (whitespace-separated; default: both views, both themes.) Each preview is
// one `.frame[data-view]`, saved whole — the frame's 620px scroll box is
// lifted so a long list is not cut off (SHOTS_CLIP=1 keeps it) — as
//   <state>/<variant>.<theme>.<density>.<view>.png
// where <variant> is `current` (the app) or a comparison id (comparisons.ts).

const STATES = (process.env.SHOTS_GALLERY ?? 'view=shop,list&theme=light,dark')
	.split(/\s+/)
	.filter(Boolean)
	.map((q) => q.replace(/^\?/, ''));

/** A state's directory name: its query, made filename-safe. */
const slug = (q: string) => q.replace(/[^A-Za-z0-9,=_-]+/g, '_').slice(0, 120) || 'default';

for (const state of STATES) {
	test(`gallery ${state}`, async ({ page }) => {
		await page.goto(`/dev/gallery?${state}`);
		// The first visit transforms the gallery's module graph on demand.
		await page.locator('[data-gallery-ready]').waitFor({ timeout: 180_000 });
		if (!process.env.SHOTS_CLIP)
			await page.addStyleTag({
				content: '.frame { height: auto !important; overflow: visible !important; }'
			});

		const frames = page.locator('section.comparison .frame[data-view]');
		await expect(frames.first()).toBeVisible();
		const count = await frames.count();
		for (let i = 0; i < count; i++) {
			const frame = frames.nth(i);
			const name = await frame.evaluate((el) => {
				const attr = (sel: string, a: string) => el.closest(sel)?.getAttribute(a) ?? 'x';
				return [
					attr('[data-variant]', 'data-variant'),
					attr('section.comparison', 'data-theme'),
					attr('[data-density]', 'data-density'),
					el.getAttribute('data-view')
				].join('.');
			});
			await frame.scrollIntoViewIfNeeded();
			await shoot(page, frame, `${slug(state)}/${name}`);
		}
	});
}
