import { expect, test, type Page } from '@playwright/test';
import { openGallery } from './gallery';

// The tile audit (§9.1, [D-166]). The design gallery's "Alle Textfälle"
// scenario renders every text case the shop view has to survive — long
// names, notes, long and unbreakable quantities — through the production
// ShopTile. For each item kind × density this walks text scales and column
// widths and measures, in the current-app row of the gallery:
//
//   - the ⓘ door overlapping the name, the note or the quantity;
//   - a VISIBLE line of any of them leaving the tile (a clamped name or an
//     ellipsed note overflows its own box invisibly, so lines are clipped to
//     their element first);
//   - the name squeezed below 24px (at 200% zoom the quantity and door keep
//     their width and the name gets what is left);
//   - a quantity cut without an ellipsis.
//
// Each of these is a geometry number that goes stale when a neighbouring
// part changes, which is why it runs as its own harness ([D-83]).

const KINDS = ['plain', 'photo', 'scan', 'failed'] as const;
const DENSITIES = ['comfortable', 'compact', 'list'] as const;
const SCALES = [100, 150, 200] as const;
const WIDTHS = [320, 390] as const;

/** Waits until the tiles have stopped moving: the pop-in animation scales
 *  them (and so their measured boxes), photos decode, and the clamp
 *  observer decides the door a frame later. */
async function settle(page: Page) {
	await page.evaluate(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
		await frame();
		// Finite animations only: a broken photo's placeholder pulses forever.
		const finite = document
			.getAnimations()
			.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.all(finite.map((a) => a.finished.catch(() => null)));
		// Bounded: a lazy image outside the viewport never loads, so its decode
		// never settles.
		const decoded = Promise.all(
			[...document.images]
				.filter((img) => !img.complete)
				.map((img) => img.decode().catch(() => null))
		);
		await Promise.race([decoded, new Promise((r) => setTimeout(r, 1000))]);
		await frame();
		await frame();
	});
}

/** One finding per tile with a problem, in the current-app shop preview. */
function audit(page: Page) {
	return page.evaluate(() => {
		type Box = { left: number; right: number; top: number; bottom: number };
		const panel = document.querySelector('[data-variant="current"] .frame[data-view="shop"]');
		if (!panel) throw new Error('gallery shop preview not rendered');
		const lines = (el: Element): Box[] => {
			const r = document.createRange();
			r.selectNodeContents(el);
			return [...r.getClientRects()].filter((x) => x.width > 0.5);
		};
		// Visible text only: each line clipped to its element's own box.
		const visible = (el: Element | null): Box[] => {
			if (!el) return [];
			const box = el.getBoundingClientRect();
			return lines(el)
				.map((l) => ({
					left: Math.max(l.left, box.left),
					right: Math.min(l.right, box.right),
					top: Math.max(l.top, box.top),
					bottom: Math.min(l.bottom, box.bottom)
				}))
				.filter((l) => l.right > l.left && l.bottom > l.top);
		};
		const hit = (a: Box, b: Box) =>
			a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
		const findings: string[] = [];
		// One grid cell per item, marked with its case id (ShopItems).
		const cells = panel.querySelectorAll<HTMLElement>('.tile-wrap[data-item]');
		if (cells.length === 0) throw new Error('no tiles rendered');
		for (const wrap of cells) {
			const tile = wrap.querySelector<HTMLElement>('.tile')!;
			const t = tile.getBoundingClientRect();
			const name = tile.querySelector('.tile-name')!;
			const qty = tile.querySelector<HTMLElement>('.qty');
			const door = wrap.querySelector('.tile-info svg');
			const parts: Record<string, Box[]> = {
				name: visible(name),
				note: visible(tile.querySelector('.tile-note')),
				qty: qty ? [qty.getBoundingClientRect()] : []
			};
			const issues: string[] = [];
			if (door) {
				const d = door.getBoundingClientRect();
				for (const [part, boxes] of Object.entries(parts))
					if (boxes.some((b) => hit(b, d))) issues.push(`door overlaps ${part}`);
			}
			for (const [part, boxes] of Object.entries(parts))
				if (
					boxes.some(
						(b) =>
							b.right > t.right - 1 ||
							b.left < t.left + 1 ||
							b.bottom > t.bottom - 1 ||
							b.top < t.top + 1
					)
				)
					issues.push(`${part} leaves the tile`);
			const nameWidth = name.getBoundingClientRect().width;
			if (nameWidth < 24) issues.push(`name squeezed to ${Math.round(nameWidth)}px`);
			if (
				qty &&
				qty.scrollWidth > qty.clientWidth + 1 &&
				getComputedStyle(qty).textOverflow !== 'ellipsis'
			)
				issues.push('quantity cut without an ellipsis');
			if (issues.length)
				findings.push(
					`${wrap.dataset.item} (${tile.dataset.kind}${door ? '+door' : ''}): ${issues.join(', ')}`
				);
		}
		return findings;
	});
}

for (const kind of KINDS)
	for (const density of DENSITIES)
		test(`${kind} tiles, ${density}: nothing overlaps or leaves the tile`, async ({ page }) => {
			await page.setViewportSize({ width: 1400, height: 1000 });
			const findings: string[] = [];
			for (const scale of SCALES)
				for (const width of WIDTHS) {
					const current = await openGallery(page, {
						content: 'stress',
						view: 'shop',
						kind,
						density,
						scale,
						width
					});
					// The URL is the only input: prove it reached the preview.
					const shop = current.locator('.frame[data-view="shop"]');
					await expect(shop).toHaveCSS('width', `${width}px`);
					await expect(shop.locator('.tile').first()).toHaveAttribute(
						'data-kind',
						kind === 'plain' ? 'typed' : 'product'
					);
					await settle(page);
					for (const f of await audit(page)) findings.push(`${scale}% ${width}px  ${f}`);
				}
			expect(findings, findings.join('\n')).toEqual([]);
		});
