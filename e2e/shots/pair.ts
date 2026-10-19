import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Two README screenshots side by side as one PNG ([D-286]), made in Chromium
// like the clip (the container has no ImageMagick). The README gives each
// pair a fixed width, and Codeberg caps an image at its column: a laptop gets
// two pairs to a row at that width, a phone one pair scaled to its width.
// Codeberg allows no CSS, <picture> or srcset that could do this otherwise.
//
//   node shots/pair.ts LEFT.png RIGHT.png OUT.png

/** Between the two phones, in image pixels: the few pixels of space the
 *  README puts between two pairs on a row, at the pairs' own scale. */
const GAP = 16;

const [left, right, out] = process.argv.slice(2);
if (!left || !right || !out) {
	console.error('usage: node shots/pair.ts LEFT.png RIGHT.png OUT.png');
	process.exit(2);
}

const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const png = await page.evaluate(
		async ({ sources, gap }) => {
			const images = await Promise.all(
				sources.map(
					(src) =>
						new Promise<HTMLImageElement>((done, fail) => {
							const img = new Image();
							img.onload = () => done(img);
							img.onerror = () => fail(new Error('an image did not load'));
							img.src = src;
						})
				)
			);
			const canvas = document.createElement('canvas');
			canvas.width = images[0].naturalWidth + gap + images[1].naturalWidth;
			canvas.height = Math.max(images[0].naturalHeight, images[1].naturalHeight);
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(images[0], 0, 0);
			ctx.drawImage(images[1], images[0].naturalWidth + gap, 0);
			return canvas.toDataURL('image/png').split(',')[1];
		},
		{ sources: [dataUrl(left), dataUrl(right)], gap: GAP }
	);
	writeFileSync(out, Buffer.from(png, 'base64'));
} finally {
	await browser.close();
}
