// prefers-reduced-motion in JS. app.css's blanket reduced-motion rule makes
// Svelte transitions invisible while Svelte still holds the element in the DOM
// for the declared duration (a removed row would sit inert for 280ms), so every
// transition takes `duration: dur(n)` rather than a literal. CSS cannot reach
// `scrollIntoView`'s behavior either; see `scrollBehavior`.
import { flip } from 'svelte/animate';
import { prefersReducedMotion } from 'svelte/motion';

/** True when the user has asked for reduced motion. Read at call time. */
export function reducedMotion(): boolean {
	return prefersReducedMotion.current;
}

/** A transition duration in ms, collapsed to 0 under reduced motion. */
export function dur(ms: number): number {
	return reducedMotion() ? 0 : ms;
}

/** `scrollIntoView` behaviour, honouring the same preference. */
export function scrollBehavior(): ScrollBehavior {
	return reducedMotion() ? 'auto' : 'smooth';
}

interface NearFlipParams {
	duration?: number;
	delay?: number;
	easing?: (t: number) => number;
}

/**
 * `animate:flip`, but only for elements near the viewport (plus 160px); the rest
 * jump instantly, since offscreen rows animating were most of a reorder's
 * main-thread cost on a long list. The params are Svelte's third argument, not
 * merged into the second. In happy-dom every rect is 0, so tests see the plain
 * flip.
 */
export function flipNear(
	node: Element,
	positions: { from: DOMRect; to: DOMRect },
	params: NearFlipParams = {}
) {
	const rect = node.getBoundingClientRect();
	const near = rect.bottom > -160 && rect.top < (globalThis.innerHeight ?? 800) + 160;
	return flip(node, positions, near ? params : { ...params, duration: 0 });
}

/**
 * The reorder-drag beat, shared by every dndzone and the `animate:flipNear` on
 * its rows. svelte-dnd-action derives its hit-testing interval
 * (`max(flipDurationMs, 100) * 1.07`, what makes a drag feel dead when long)
 * and its drop-clone removal from `flipDurationMs`; a mismatch with the rows'
 * flip ends a drop in a visible double-take.
 */
export const DND_FLIP_MS = 120;

/** The reflow beat when a row or tile moves, through `dur()` too. */
export const ROW_FLIP_MS = 240;
