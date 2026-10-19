import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openGallery, type GalleryQuery } from './gallery';

// The state audit ([D-228]): axe, a touch-target sweep and a check that every
// picture is drawn, over the design gallery's current-app row — the checks [D-213] ran once by hand. The
// functional suite's a11y scan (e2e/tests/a11y.spec.ts) walks the real app,
// but a real list holds the few items a spec creates; only the gallery has
// every text case, item kind, density and list state at once, in both
// themes, at enlarged text. Each page below renders all four densities and
// both themes side by side, so one load is eight panels.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ALL: GalleryQuery = {
	theme: ['light', 'dark'],
	density: ['comfortable', 'compact', 'list']
};
const PAGES: { name: string; query: GalleryQuery }[] = [
	{ name: 'every text case', query: { content: 'stress' } },
	{ name: 'every photo case', query: { content: 'photos' } },
	{ name: 'all done', query: { content: 'everyday', state: 'done' } },
	{ name: 'empty list', query: { state: 'empty' } },
	{ name: 'A–Z order', query: { content: 'everyday', order: 'az' } }
];
const SCALES = [100, 200] as const;

/** Waits for finite animations (tile pop-in, sheet slides) to finish. */
async function settle(page: Page) {
	await page.evaluate(async () => {
		const finite = document
			.getAnimations()
			.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.all(finite.map((a) => a.finished.catch(() => null)));
	});
}

/** Every visible control in the current row whose tappable area is under
 *  44px across or down ([D-56]). Hit-tested, not measured: the app reaches
 *  44px with an `::after` inset (`hit-target`, the tile door) that no box
 *  reports, and a neighbour painted over that extension takes the tap. From
 *  the control's centre this walks outwards in 1px steps on each side until
 *  the point stops landing on the control, and sums the two sides of an axis.
 *  The centre sits on a fraction of a pixel, so a true 44px target sums to
 *  43 or 44 here; 42 allows for that and nothing more. */
function smallTargets(page: Page) {
	return page.evaluate(() => {
		const MIN = 42;
		const findings: string[] = [];
		const controls = document.querySelectorAll<HTMLElement>(
			'[data-variant="current"] .frame :is(button, a[href], input, select, textarea, [role="button"])'
		);
		const describe = (el: Element | null) => {
			if (!el) return 'nothing';
			const name = [...el.classList].find((c) => !c.startsWith('svelte-'));
			return `${el.tagName.toLowerCase()}${name ? `.${name}` : ''}`;
		};
		for (const el of controls) {
			if (el.getClientRects().length === 0) continue;
			el.scrollIntoView({ block: 'center', inline: 'center' });
			const box = el.getBoundingClientRect();
			const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
			/** How far the control reaches from its centre, and what is next. */
			const reach = (dx: number, dy: number): [number, string] => {
				const at = (r: number) => document.elementFromPoint(x + dx * r, y + dy * r);
				let r = 0;
				while (r < 32 && el.contains(at(r + 1))) r += 1;
				return [r, describe(at(r + 1))];
			};
			const short: string[] = [];
			for (const [axis, a, b] of [
				['across', reach(-1, 0), reach(1, 0)],
				['down', reach(0, -1), reach(0, 1)]
			] as const) {
				const size = a[0] + b[0] + 1;
				if (size < MIN) short.push(`${size}px ${axis} (then ${a[1]} / ${b[1]})`);
			}
			if (short.length === 0) continue;
			const where = el.closest<HTMLElement>('[data-item]')?.dataset.item ?? '-';
			const view = el.closest<HTMLElement>('.frame')?.dataset.view;
			const density = el.closest<HTMLElement>('.panel')?.dataset.density;
			findings.push(`${view}/${density} ${where}: ${describe(el)} ${short.join(', ')}`);
		}
		return [...new Set(findings)];
	});
}

/** Every picture in the current row that is laid out but not drawn: an
 *  `<img>` or `<svg>` with a box under 1px either way. An aisle icon sized as
 *  a percentage of a content-sized grid track was 0px wide in Firefox from
 *  v0.10.1 to v0.13.7, with nothing else wrong: it loaded, overlapped
 *  nothing and is no control. Hidden ones (no box at all) are skipped. */
function undrawnPictures(page: Page) {
	return page.evaluate(() => {
		const findings: string[] = [];
		const pictures = document.querySelectorAll<Element>(
			'[data-variant="current"] .frame :is(img, svg)'
		);
		for (const el of pictures) {
			if (el.getClientRects().length === 0) continue;
			const box = el.getBoundingClientRect();
			if (box.width >= 1 && box.height >= 1) continue;
			const where = el.closest<HTMLElement>('[data-item]')?.dataset.item ?? '-';
			const view = el.closest<HTMLElement>('.frame')?.dataset.view;
			const density = el.closest<HTMLElement>('.panel')?.dataset.density;
			const inside = [...(el.parentElement?.classList ?? [])].find((c) => !c.startsWith('svelte-'));
			findings.push(
				`${view}/${density} ${where}: ${el.tagName.toLowerCase()} in .${inside ?? '?'} is ${box.width.toFixed(1)}×${box.height.toFixed(1)}px`
			);
		}
		return [...new Set(findings)];
	});
}

test.use({ reducedMotion: 'reduce' });

for (const { name, query } of PAGES)
	test(`${name}: no axe violation, no target under 44px, every picture drawn`, async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 1000 });
		const findings: string[] = [];
		for (const scale of SCALES) {
			await openGallery(page, { ...ALL, ...query, scale });
			await settle(page);
			const results = await new AxeBuilder({ page })
				.include('[data-variant="current"] .frame')
				.withTags(WCAG_TAGS)
				// axe sizes a target by its box and cannot see the ::after
				// extensions; the hit-test sweep below holds the stricter 44px.
				.disableRules(['target-size'])
				.analyze();
			for (const v of results.violations)
				for (const n of v.nodes) findings.push(`${scale}% axe ${v.id}: ${n.target.join(' ')}`);
			for (const f of await smallTargets(page)) findings.push(`${scale}% target ${f}`);
			for (const f of await undrawnPictures(page)) findings.push(`${scale}% picture ${f}`);
		}
		expect(findings, findings.join('\n')).toEqual([]);
	});
