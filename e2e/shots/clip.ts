import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { OUT } from './shots';

// A short clip of two phones side by side, as an animated WebP — what a
// README <img> can show, made without ffmpeg (the container has none):
//
//   1. record(): each phone's frames over the DevTools screencast, with
//      their timestamps, while the scene plays;
//   2. compose(): a canvas page lays the two phones out with their names and
//      the scene's subtitle at a fixed frame rate and encodes each frame as
//      a still WebP (Chromium's canvas.toBlob). The phone whose turn it is
//      has its name in green, and a change that reaches the other phone is
//      outlined there as it lands: sync takes a fraction of a second, and
//      without a pointer the eye is looking at the wrong spot when it does;
//      Only the rectangle that changed since the previous frame is encoded:
//      a sync touches one tile, and full frames made the clip 3 MB;
//   3. animate(): the stills become one animated WebP (RIFF VP8X/ANIM/ANMF,
//      the container format from Google's WebP spec), each drawn at its
//      offset over the frames before it. A run of identical frames becomes
//      one frame with a longer duration.

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
	webp: string;
	key: string;
	x: number;
	y: number;
}

interface AnimFrame {
	webp: Buffer;
	ms: number;
	x: number;
	y: number;
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
			let previous: Uint32Array | null = null;
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
					out.push({ webp: '', key, x: 0, y: 0 });
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
				// The changed rectangle, its corner on even pixels: ANMF stores
				// offsets halved.
				const pixels = new Uint32Array(ctx.getImageData(0, 0, W, H).data.buffer);
				let [x0, y0, x1, y1] = [W, H, -1, -1];
				for (let y = 0; y < H; y++)
					for (let x = 0; x < W; x++) {
						const i = y * W + x;
						if (previous && pixels[i] === previous[i]) continue;
						if (x < x0) x0 = x;
						if (x > x1) x1 = x;
						if (y < y0) y0 = y;
						if (y > y1) y1 = y;
					}
				previous = pixels;
				if (x1 < 0) {
					out.push({ webp: '', key, x: 0, y: 0 });
					continue;
				}
				x0 -= x0 % 2;
				y0 -= y0 % 2;
				const part = document.createElement('canvas');
				part.width = x1 - x0 + 1;
				part.height = y1 - y0 + 1;
				part.getContext('2d', { alpha: false })!.drawImage(canvas, -x0, -y0);
				const blob = await new Promise<Blob>((done) =>
					part.toBlob((b) => done(b!), 'image/webp', 0.82)
				);
				const bytes = new Uint8Array(await blob.arrayBuffer());
				let bin = '';
				for (let i = 0; i < bytes.length; i += 0x8000)
					bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
				out.push({ webp: btoa(bin), key, x: x0, y: y0 });
			}
			return out;
		},
		{ rec, labels, fps, MARK_MS, GREEN }
	);
	await page.context().close();

	// Runs of one still become one frame with the run's duration.
	const step = 1000 / fps;
	const runs: AnimFrame[] = [];
	for (const s of stills) {
		if (s.webp) runs.push({ webp: Buffer.from(s.webp, 'base64'), ms: step, x: s.x, y: s.y });
		else runs[runs.length - 1].ms += step;
	}
	runs[runs.length - 1].ms += 1500; // hold the last frame before the loop
	const path = resolve(OUT, `${name}.webp`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, animate(runs));
}

const u24 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
const chunk = (fourcc: string, body: Buffer) => {
	const head = Buffer.alloc(8);
	head.write(fourcc, 0, 'ascii');
	head.writeUInt32LE(body.length, 4);
	return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

/** Still WebPs → one animated WebP. Each still's image chunks (VP8/VP8L, and
 *  ALPH if any) go into an ANMF frame as they are, at the still's offset; the
 *  first is the whole canvas. */
function animate(frames: AnimFrame[]): Buffer {
	const parts = frames.map(({ webp, ms, x, y }) => {
		if (webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP')
			throw new Error('not a WebP still');
		let width = 0;
		let height = 0;
		const image: Buffer[] = [];
		for (let at = 12; at < webp.length;) {
			const fourcc = webp.toString('ascii', at, at + 4);
			const size = webp.readUInt32LE(at + 4);
			const body = webp.subarray(at + 8, at + 8 + size);
			if (fourcc === 'VP8X') {
				width = body.readUIntLE(4, 3) + 1;
				height = body.readUIntLE(7, 3) + 1;
			} else if (fourcc === 'VP8 ') {
				width ||= body.readUInt16LE(6) & 0x3fff;
				height ||= body.readUInt16LE(8) & 0x3fff;
				image.push(chunk(fourcc, body));
			} else if (fourcc === 'VP8L') {
				const bits = body.readUInt32LE(1);
				width ||= (bits & 0x3fff) + 1;
				height ||= ((bits >> 14) & 0x3fff) + 1;
				image.push(chunk(fourcc, body));
			} else if (fourcc === 'ALPH') image.push(chunk(fourcc, body));
			at += 8 + size + (size % 2);
		}
		const head = Buffer.concat([
			u24(x / 2),
			u24(y / 2),
			u24(width - 1),
			u24(height - 1),
			u24(Math.round(ms)),
			Buffer.from([0b10])
		]);
		return { width, height, anmf: chunk('ANMF', Buffer.concat([head, ...image])) };
	});
	const { width, height } = parts[0];
	const vp8x = chunk(
		'VP8X',
		Buffer.concat([Buffer.from([0b10, 0, 0, 0]), u24(width - 1), u24(height - 1)])
	);
	const anim = chunk('ANIM', Buffer.from([0, 0, 0, 0, 0, 0]));
	const body = Buffer.concat([
		Buffer.from('WEBP', 'ascii'),
		vp8x,
		anim,
		...parts.map((p) => p.anmf)
	]);
	const riff = Buffer.alloc(8);
	riff.write('RIFF', 0, 'ascii');
	riff.writeUInt32LE(body.length, 4);
	return Buffer.concat([riff, body]);
}
