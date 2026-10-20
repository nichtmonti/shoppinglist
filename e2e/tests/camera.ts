import type { Page } from '@playwright/test';

// A camera with a real EAN-13 label in front of it: the back of a carton,
// drawn on a canvas and handed to the app as its camera stream. Only
// getUserMedia is replaced — the app's own decoder (barcode-detector and the
// zxing-wasm binary it ships) reads the frames, which is what
// scan-decode.spec.ts tests and what the scan screenshots (e2e/shots) show.
// Everything else a scan does is up to the caller: scan-decode.spec.ts stubs
// the lookup, the screenshots let the server ask Open Food Facts.
//
// The label starts half out of frame, so the decoder cannot read it and the
// viewfinder can be photographed; aimCamera() pans it into view.

/** EAN-13 → its 95 modules ('1' = bar), guards included. */
export function ean13(code: string): string {
	if (!/^\d{13}$/.test(code)) throw new Error(`not an EAN-13: ${code}`);
	const L = '0001101 0011001 0010011 0111101 0100011 0110001 0101111 0111011 0110111 0001011'.split(
		' '
	);
	const G = '0100111 0110011 0011011 0100001 0011101 0111001 0000101 0010001 0001001 0010111'.split(
		' '
	);
	const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
	const PARITY = 'LLLLLL LLGLGG LLGGLG LLGGGL LGLLGG LGGLLG LGGGLL LGLGLG LGLGGL LGGLGL'.split(' ');
	const d = [...code].map(Number);
	let bits = '101';
	for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L : G)[d[i]];
	bits += '01010';
	for (let i = 7; i <= 12; i++) bits += R[d[i]];
	return bits + '101';
}

/** Installs the camera on every page `page` loads from now on. */
export async function installCamera(page: Page, code: string): Promise<void> {
	await page.addInitScript(
		({ code, bits }) => {
			const w = window as unknown as { __shotsAim?: number };
			const canvas = document.createElement('canvas');
			canvas.width = 1280;
			canvas.height = 720;
			const ctx = canvas.getContext('2d', { alpha: false })!;
			const MODULE = 6;
			const labelW = (bits.length + 22) * MODULE;
			const labelH = 330;
			const draw = (now: number) => {
				// x of the label's left edge: half off the frame until aimed, then
				// a 600ms pan to the centre.
				const off = canvas.width - labelW * 0.45;
				const centre = (canvas.width - labelW) / 2;
				const p = w.__shotsAim ? Math.min(1, (now - w.__shotsAim) / 600) : 0;
				const x = off + (centre - off) * (1 - (1 - p) ** 3);
				const y = (canvas.height - labelH) / 2;
				const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
				bg.addColorStop(0, '#8d7a62');
				bg.addColorStop(1, '#5e4f3e');
				ctx.fillStyle = bg;
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.fillStyle = '#dcdcd8';
				ctx.fillRect(x - 160, 40, labelW + 320, canvas.height - 80);
				ctx.fillStyle = '#fff';
				ctx.fillRect(x, y, labelW, labelH);
				ctx.fillStyle = '#111';
				for (let i = 0; i < bits.length; i++)
					if (bits[i] === '1') ctx.fillRect(x + (11 + i) * MODULE, y + 30, MODULE, 230);
				ctx.font = '600 40px monospace';
				ctx.textAlign = 'center';
				ctx.fillText(`${code[0]}  ${code.slice(1, 7)}  ${code.slice(7)}`, x + labelW / 2, y + 305);
				requestAnimationFrame(draw);
			};
			// A fresh stream per call: the app stops a scan's tracks when it ends.
			navigator.mediaDevices.getUserMedia = async () => {
				if (!canvas.isConnected) {
					canvas.style.cssText = 'position:fixed;left:-9999px;top:0';
					document.documentElement.append(canvas);
					requestAnimationFrame(draw);
				}
				return canvas.captureStream(30);
			};
		},
		{ code, bits: ean13(code) }
	);
}

/** Pans the label into the camera's view; the decoder reads it from there. */
export async function aimCamera(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { __shotsAim?: number }).__shotsAim = performance.now();
	});
}

/** Takes the label back out of view, for the next scan. */
export async function lowerCamera(page: Page): Promise<void> {
	await page.evaluate(() => {
		delete (window as unknown as { __shotsAim?: number }).__shotsAim;
	});
}
