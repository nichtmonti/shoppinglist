// openPhotoViewer (§9.1, [D-94]): dimensions are read at tap time, the
// PhotoSwipe module loads only on demand, and an undecodable photo never
// opens. The module + Image transport are stubbed — no layout, no network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { MockPhotoSwipe, seenOptions, seenElements, instances } = vi.hoisted(() => ({
	MockPhotoSwipe: vi.fn(),
	seenOptions: [] as unknown[],
	// DOM-free stand-in for the viewer root: this file runs in the node
	// project, so no document — and the fake also proves the helper only
	// touches setAttribute, nothing else.
	seenElements: [] as { setAttribute: ReturnType<typeof vi.fn> }[],
	instances: [] as { handlers: Record<string, (() => void)[]> }[]
}));
vi.mock('photoswipe', () => ({
	default: class {
		options: unknown;
		element: { setAttribute: ReturnType<typeof vi.fn> };
		handlers: Record<string, (() => void)[]> = {};
		init = vi.fn();
		on = vi.fn((event: string, cb: () => void) => {
			(this.handlers[event] ??= []).push(cb);
		});
		constructor(options: unknown) {
			this.options = options;
			this.element = { setAttribute: vi.fn() };
			MockPhotoSwipe(options);
			seenOptions.push(options);
			seenElements.push(this.element);
			instances.push(this);
		}
	}
}));
// The stylesheet import rides the real pipeline (vitest stubs CSS) — only
// the module constructor is mocked.

import { openPhotoViewer } from './photo-lightbox';

function stubImage(size: { w: number; h: number } | 'error'): void {
	vi.stubGlobal(
		'Image',
		class {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			naturalWidth = 0;
			naturalHeight = 0;
			set src(_: string) {
				if (size === 'error') {
					queueMicrotask(() => this.onerror?.());
				} else {
					this.naturalWidth = size.w;
					this.naturalHeight = size.h;
					queueMicrotask(() => this.onload?.());
				}
			}
		}
	);
}

beforeEach(() => {
	// Close what the last test left open: only one viewer opens at a time.
	for (const pswp of instances) for (const cb of pswp.handlers.destroy ?? []) cb();
	vi.clearAllMocks();
	seenOptions.length = 0;
	seenElements.length = 0;
	instances.length = 0;
	vi.unstubAllGlobals();
});

function fireViewer(event: 'destroy'): void {
	for (const cb of instances[0]?.handlers[event] ?? []) cb();
}

describe('openPhotoViewer', () => {
	// [D-94] unmounts the sheet under the viewer; a second viewer from a quick
	// double tap would outlive the first's close, over a sheet that came back.
	it('opens one viewer for a double tap, and another once it is closed', async () => {
		stubImage({ w: 400, h: 300 });

		const [first, second] = await Promise.all([
			openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme'),
			openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme')
		]);

		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(MockPhotoSwipe).toHaveBeenCalledTimes(1);

		fireViewer('destroy');
		expect(await openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme')).toBe(true);
		expect(MockPhotoSwipe).toHaveBeenCalledTimes(2);
	});

	it('opens a single chromeless slide capped at 2x from the measured size', async () => {
		stubImage({ w: 400, h: 300 });

		const opened = await openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme');

		expect(opened).toBe(true);
		expect(MockPhotoSwipe).toHaveBeenCalledTimes(1);
		expect(seenOptions[0]).toMatchObject({
			dataSource: [{ src: '/api/barcode/photo/abc', width: 400, height: 300, alt: 'Sonnencreme' }],
			secondaryZoomLevel: 2,
			maxZoomLevel: 2,
			zoom: false,
			close: false,
			counter: false,
			arrowPrev: false,
			arrowNext: false
		});
		// The chromeless root carries no name of its own — the helper labels
		// it with the product.
		expect(seenElements).toHaveLength(1);
		expect(seenElements[0].setAttribute).toHaveBeenCalledWith('aria-label', 'Sonnencreme');
	});

	it('reports open and close so the sheet underneath can suspend dismissal', async () => {
		stubImage({ w: 400, h: 300 });
		const onopen = vi.fn();
		const onclose = vi.fn();

		await openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme', { onopen, onclose });

		expect(onopen).toHaveBeenCalledTimes(1);
		expect(onclose).not.toHaveBeenCalled();
		fireViewer('destroy');
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('reports nothing when the photo never opens', async () => {
		stubImage('error');
		const onopen = vi.fn();
		const onclose = vi.fn();

		await openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme', { onopen, onclose });

		expect(onopen).not.toHaveBeenCalled();
		expect(onclose).not.toHaveBeenCalled();
	});

	it('never opens for a photo that will not decode', async () => {
		stubImage('error');

		const opened = await openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme');

		expect(opened).toBe(false);
		expect(MockPhotoSwipe).not.toHaveBeenCalled();
	});

	it('never opens for a zero-size decode', async () => {
		stubImage({ w: 0, h: 0 });

		const opened = await openPhotoViewer('/api/barcode/photo/abc', 'Sonnencreme');

		expect(opened).toBe(false);
		expect(MockPhotoSwipe).not.toHaveBeenCalled();
	});
});
