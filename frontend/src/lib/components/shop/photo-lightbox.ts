// Fullscreen product photo viewer (§9.1, [D-94]): PhotoSwipe for one slide,
// on the sheet's cached token URL, touch gestures only, no visible controls,
// zoom capped at 2x against the ~400px source.
import type PhotoSwipe from 'photoswipe';
import { reducedMotion } from '#lib/state/motion.js';

function photoSize(src: string): Promise<{ width: number; height: number } | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			resolve(
				img.naturalWidth > 0 && img.naturalHeight > 0
					? { width: img.naturalWidth, height: img.naturalHeight }
					: null
			);
		};
		img.onerror = () => resolve(null);
		img.src = src;
	});
}

/** Lifecycle hooks for the layer underneath, which must unmount while the
 *  viewer is open: two focus traps fight, and every gesture on the viewer is
 *  "outside" the sheet. */
export interface PhotoViewerHooks {
	/** `close` closes the viewer: the layer's back entry ([D-230]) calls it. */
	onopen?: (close: () => void) => void;
	onclose?: () => void;
}

// One viewer at a time, from the tap until it closes: a double tap would
// otherwise open a second one that outlives the first's onclose.
let viewerBusy = false;

/** Opens `src` fullscreen; false when the photo will not decode or a viewer
 *  is already open. `label` names the dialog for assistive tech. */
export async function openPhotoViewer(
	src: string,
	label: string,
	hooks?: PhotoViewerHooks
): Promise<boolean> {
	if (viewerBusy) return false;
	viewerBusy = true;
	try {
		return await showViewer(src, label, hooks);
	} catch (error) {
		viewerBusy = false;
		throw error;
	}
}

async function showViewer(src: string, label: string, hooks?: PhotoViewerHooks): Promise<boolean> {
	const size = await photoSize(src);
	if (!size) {
		viewerBusy = false;
		return false;
	}
	const [{ default: PhotoSwipeCtor }] = await Promise.all([
		import('photoswipe'),
		import('photoswipe/style.css')
	]);
	const reduced = reducedMotion();
	const pswp: PhotoSwipe = new PhotoSwipeCtor({
		dataSource: [{ src, width: size.width, height: size.height, alt: label }],
		secondaryZoomLevel: 2,
		maxZoomLevel: 2,
		bgOpacity: 0.92,
		bgClickAction: 'close',
		closeOnVerticalDrag: true,
		pinchToClose: true,
		escKey: true,
		arrowKeys: false,
		trapFocus: true,
		returnFocus: true,
		showHideAnimationType: reduced ? 'none' : 'fade',
		// Chromeless: close by drag-down, background tap or Escape.
		zoom: false,
		close: false,
		counter: false,
		arrowPrev: false,
		arrowNext: false
	});
	pswp.init();
	// PhotoSwipe's root has no accessible name of its own.
	pswp.element?.setAttribute('aria-label', label);
	hooks?.onopen?.(() => pswp.close());
	pswp.on('destroy', () => {
		viewerBusy = false;
		hooks?.onclose?.();
	});
	return true;
}
