import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import sharp from 'sharp';
import { OUT } from './shots';

// A short clip of two phones side by side, as an animated WebP — what a
// README <img> can show, made without ffmpeg (the container has none):
//
//   1. record(): each phone's frames over the DevTools screencast, with
//      their timestamps, while the scene plays;
//   2. compose(): a canvas page lays the two phones out with their names and
//      the scene's subtitle at a fixed frame rate, each frame a PNG. The phone
//      whose turn it is has its name in green, and a change that reaches the
//      other phone is outlined there as it lands: sync takes a fraction of a
//      second, and without a pointer the eye is looking at the wrong spot when
//      it does. A run of identical frames becomes one frame with a longer
//      duration;
//   3. sharp joins the frames into one animated WebP. libwebp's animation
//      encoder stores only what changed since the frame before (a sync touches
//      one tile; full frames made the clip 3 MB).

interface Frame {
	t: number;
	data: string;
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Recording {
	frames: Frame[][];
	captions: { t: number; text: string; actor?: number }[];
	/** Where a phone was touched, in its CSS pixels, for the tap marker. */
	taps: { t: number; phone: number; x: number; y: number }[];
	/** Where a change landed on a phone, in its CSS pixels. */
	marks: { t: number; phone: number; box: Box }[];
	/** The phones' viewport width in CSS pixels. */
	viewportWidth: number;
	start: number;
	end: number;
}

export interface Scene {
	/** Starts a subtitle; it stays until the next one. `actor` is the phone
	 *  whose turn it is: its name turns green. */
	caption: (text: string, actor?: number) => void;
	/** Taps `target` on phone `phone`, and marks the spot in the clip. */
	tap: (phone: number, target: Locator) => Promise<void>;
	/** Outlines `target` on phone `phone`, where a change just landed. */
	mark: (phone: number, target: Locator) => Promise<void>;
}

async function boxOf(target: Locator): Promise<Box> {
	const box = await target.boundingBox();
	if (!box) throw new Error('target is not on screen');
	return box;
}

/** Records `pages` while `scene` runs. */
export async function record(
	pages: Page[],
	scene: (s: Scene) => Promise<void>
): Promise<Recording> {
	const frames: Frame[][] = pages.map(() => []);
	await Promise.all(
		pages.map((page, i) =>
			page.screencast.start({
				quality: 90,
				onFrame: ({ data, timestamp }) => {
					frames[i].push({ t: timestamp, data: data.toString('base64') });
				}
			})
		)
	);
	const captions: Recording['captions'] = [];
	const taps: Recording['taps'] = [];
	const marks: Recording['marks'] = [];
	// Let both screencasts deliver a first frame before the scene starts.
	await pages[0].waitForTimeout(500);
	const start = Date.now();
	await scene({
		caption: (text, actor) => void captions.push({ t: Date.now(), text, actor }),
		tap: async (phone, target) => {
			const box = await boxOf(target);
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			taps.push({ t: Date.now(), phone, x, y });
			await target.click();
		},
		mark: async (phone, target) => {
			marks.push({ t: Date.now(), phone, box: await boxOf(target) });
		}
	});
	const end = Date.now();
	await Promise.all(pages.map((page) => page.screencast.stop()));
	return {
		frames,
		captions,
		taps,
		marks,
		start,
		end,
		viewportWidth: pages[0].viewportSize()!.width
	};
}

/** One composed frame: the changed rectangle as a still WebP, at x, y. An
 *  empty `webp` repeats the frame before. */
interface Still {
	png: string;
	key: string;
}

/** How long a mark stays on screen, its last 600ms fading. */
const MARK_MS = 2500;
/** The app's primary green, for the acting phone's name and the marks. */
const GREEN = '#05773b';

/** Lays the recording out and writes OUT/<name>.webp. */
export async function compose(
	browser: Browser,
	rec: Recording,
	{ name, labels, fps = 10 }: { name: string; labels: string[]; fps?: number }
): Promise<void> {
	const page = await (await browser.newContext()).newPage();
	await page.setContent('<!doctype html><body style="margin:0;background:#fff"></body>');
	const stills: Still[] = await page.evaluate(
		async ({ rec, labels, fps, MARK_MS, GREEN }) => {
			const load = async (data: string) =>
				createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
			const phones = await Promise.all(
				rec.frames.map(async (list) =>
					Promise.all(list.map(async (f) => ({ t: f.t, img: await load(f.data) })))
				)
			);
			const PHONE_W = 360;
			const scale = PHONE_W / phones[0][0].img.width;
			const PHONE_H = Math.round(phones[0][0].img.height * scale);
			const PAD = 24;
			const HEAD = 44;
			const FOOT = 72;
			const W = PAD * 3 + PHONE_W * 2;
			const H = HEAD + PHONE_H + FOOT;
			const canvas = document.createElement('canvas');
			canvas.width = W;
			canvas.height = H;
			const ctx = canvas.getContext('2d', { alpha: false })!;
			const out: Still[] = [];
			for (let t = rec.start; t <= rec.end; t += 1000 / fps) {
				const pick = phones.map((list) => {
					let i = 0;
					while (i + 1 < list.length && list[i + 1].t <= t) i++;
					return i;
				});
				const current = rec.captions.filter((c) => c.t <= t).at(-1);
				const caption = current?.text ?? '';
				// A tap shows as a ring for 450ms, fading out.
				const taps = rec.taps.filter((tap) => tap.t <= t && t - tap.t < 450);
				const marks = rec.marks.filter((m) => m.t <= t && t - m.t < MARK_MS);
				const key = [
					pick.join(','),
					caption,
					current?.actor,
					taps.map((tap) => Math.floor((t - tap.t) / 90)).join(','),
					marks.map((m) => Math.floor((t - m.t) / 100)).join(',')
				].join('|');
				if (out.length && out.at(-1)!.key === key) {
					out.push({ png: '', key });
					continue;
				}
				ctx.fillStyle = '#f4f3ee';
				ctx.fillRect(0, 0, W, H);
				ctx.fillStyle = '#1d1d1b';
				ctx.font = '600 20px system-ui, sans-serif';
				ctx.textAlign = 'center';
				phones.forEach((list, i) => {
					const x = PAD + i * (PHONE_W + PAD);
					ctx.fillStyle = current?.actor === i ? GREEN : '#1d1d1b';
					ctx.font = '600 20px system-ui, sans-serif';
					ctx.fillText(labels[i], x + PHONE_W / 2, 30);
					ctx.save();
					ctx.beginPath();
					ctx.roundRect(x, HEAD, PHONE_W, PHONE_H, 18);
					ctx.clip();
					ctx.drawImage(list[pick[i]].img, x, HEAD, PHONE_W, PHONE_H);
					const k = PHONE_W / rec.viewportWidth;
					// A mark pops in a little large, holds, then fades.
					for (const m of marks.filter((m) => m.phone === i)) {
						const age = t - m.t;
						const fade = Math.min(1, Math.max(0, (MARK_MS - age) / 600));
						const grow = 8 * Math.max(0, 1 - age / 250);
						const b = m.box;
						ctx.beginPath();
						ctx.roundRect(
							x + b.x * k - 4 - grow,
							HEAD + b.y * k - 4 - grow,
							b.width * k + 8 + 2 * grow,
							b.height * k + 8 + 2 * grow,
							14
						);
						ctx.fillStyle = `rgba(5, 119, 59, ${0.12 * fade})`;
						ctx.fill();
						ctx.strokeStyle = `rgba(5, 119, 59, ${0.9 * fade})`;
						ctx.lineWidth = 4;
						ctx.stroke();
					}
					ctx.restore();
					for (const tap of taps.filter((tap) => tap.phone === i)) {
						const age = (t - tap.t) / 450;
						ctx.fillStyle = `rgba(30, 30, 30, ${0.28 * (1 - age)})`;
						ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * (1 - age)})`;
						ctx.lineWidth = 3;
						ctx.beginPath();
						ctx.arc(x + tap.x * k, HEAD + tap.y * k, 18 + 10 * age, 0, Math.PI * 2);
						ctx.fill();
						ctx.stroke();
					}
					ctx.strokeStyle = '#c9c7bd';
					ctx.lineWidth = 2;
					ctx.beginPath();
					ctx.roundRect(x, HEAD, PHONE_W, PHONE_H, 18);
					ctx.stroke();
				});
				ctx.fillStyle = '#1d1d1b';
				ctx.font = '500 22px system-ui, sans-serif';
				ctx.fillText(caption, W / 2, HEAD + PHONE_H + 44);
				out.push({ png: canvas.toDataURL('image/png').split(',')[1], key });
			}
			return out;
		},
		{ rec, labels, fps, MARK_MS, GREEN }
	);
	await page.context().close();

	// Runs of one still become one frame with the run's duration.
	const step = 1000 / fps;
	const frames: Buffer[] = [];
	const delay: number[] = [];
	for (const s of stills) {
		if (s.png) {
			frames.push(Buffer.from(s.png, 'base64'));
			delay.push(step);
		} else delay[delay.length - 1] += step;
	}
	delay[delay.length - 1] += 1500; // hold the last frame before the loop
	const path = resolve(OUT, `${name}.webp`);
	mkdirSync(dirname(path), { recursive: true });
	await sharp(frames, { join: { animated: true } })
		.webp({ quality: 82, delay: delay.map(Math.round), loop: 0, minSize: true })
		.toFile(path);
}
