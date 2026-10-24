// The app's history entries ([D-230]): what the system back and the
// in-app ‹ buttons agree on.
//
// A screen's entry can carry layers, each a shallow entry (same URL) on top:
// a MODE (an arrange mode) or an OVERLAY (an open sheet, dialog or menu,
// registered through `backClosable`). A layer is open exactly while its entry
// is in `page.state`; closing one any other way goes back over its entry, so
// no entry outlives what it stood for.
//
// Move between screens through the helpers below, never a bare goto(): they
// take the layers off first, and `goForward` records `page.state.from` so
// `goUp`/`goBack` go BACK to that entry instead of pushing a second copy.
//
// Every history operation runs in turn (`serial`): traversals and shallow
// pushes are asynchronous, and a push issued before an earlier back lands
// would be popped by it. An overlay's push also waits a task, so a menu item
// opening a dialog pops the menu's entry before it pushes the dialog's.
//
// Every entry made here keeps its state across a reload (`persistState`), so a
// ‹ after one still goes back rather than adding a copy, and a mode comes back
// open. An overlay does not: back from there passes once through an entry
// whose sheet no longer exists, which is accepted, and its key, unique to the
// page load, matches no overlay of the new one.
import { untrack } from 'svelte';
import { afterNavigate, goto } from '$app/navigation';
import { navigating, page } from '$app/state';
import type { ResolvedPathname } from '$app/types';
import { serialQueue } from '#lib/serial.js';

export type HistoryMode = 'arrange-lists' | 'arrange-categories' | 'import-review';

const serial = serialQueue();

/** The shallow entries above the screen's own. */
function layers(): number {
	return (page.state.mode ? 1 : 0) + (page.state.overlays?.length ?? 0);
}

/**
 * `history.go(delta)`, settled once the traversal has landed (SvelteKit's
 * popstate listener runs first, so `page.state` is current by then). The timer
 * is a backstop: a refused traversal fires no popstate.
 */
function go(delta: number): Promise<void> {
	if (delta === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			removeEventListener('popstate', done);
			resolve();
		};
		const timer = setTimeout(done, 1000);
		addEventListener('popstate', done);
		history.go(delta);
	});
}

function unwind(): Promise<void> {
	return go(-layers());
}

/**
 * A shallow entry on the current one, same URL, carrying `state`. It waits for
 * a pending navigation first, because a shallow `goto` takes over SvelteKit's
 * current navigation and would abort a screen still loading.
 */
async function push(state: App.PageState, replace = false): Promise<void> {
	await navigating.complete?.catch(() => {});
	return shallow('', { replace, state });
}

/**
 * The current page's own entry, shallow: at its URL (`''`) or at that URL with
 * its query rewritten. SvelteKit 3 does this through `goto` (it deprecated
 * `pushState`/`replaceState`), and lint's `resolve()` rule has no form for a
 * page's own URL, so this is the one place that says so; a move to another
 * screen goes through the helpers below, typed `ResolvedPathname`.
 */
function shallow(url: string | URL, opts: { replace: boolean; state?: App.PageState }) {
	// eslint-disable-next-line svelte/no-navigation-without-resolve -- the page's own URL (above)
	return goto(url, { shallow: true, persistState: true, ...opts });
}

/** Replaces the current entry's URL, shallow: a query the screen strips or
 *  rewrites (the import's shared text, the setup token, the gallery's axes). */
export function replaceOwnUrl(url: string | URL, state?: App.PageState): Promise<void> {
	return shallow(url, { replace: true, ...(state && { state }) });
}

/** The state an entry replacing the current one inherits: what is behind it. */
function behind(): App.PageState {
	return page.state.from ? { from: page.state.from } : {};
}

// ── modes ────────────────────────────────────────────────────────────────

/** Whether `mode` is the open one. Reactive: reads `page.state`. */
export function modeOpen(mode: HistoryMode): boolean {
	return page.state.mode === mode;
}

export function openMode(mode: HistoryMode): void {
	setTimeout(
		() =>
			void serial(() => {
				if (!page.state.mode) return push({ ...page.state, mode });
			})
	);
}

/** Closes `mode` if it is open, by going back over its entry (and any overlay above it). */
export function closeMode(mode: HistoryMode): void {
	void serial(async () => {
		if (page.state.mode === mode) await go(-(1 + (page.state.overlays?.length ?? 0)));
	});
}

// ── overlays ─────────────────────────────────────────────────────────────

// Overlay keys outlive their page load in history state, so each load has its own.
const loadKey = Date.now().toString(36);
let nextKey = 0;

/**
 * Gives an overlay a history entry while it is open, so back closes it. Call
 * during component init. `close` runs when the entry went away while the
 * overlay was still open: the system back, or a navigation taking the
 * screen's layers off.
 */
export function backClosable(isOpen: () => boolean, close: () => void): void {
	const key = `overlay-${loadKey}-${++nextKey}`;
	const present = (): boolean => page.state.overlays?.includes(key) ?? false;
	let wanted = false;
	let had = false;

	function sync(): void | Promise<void> {
		if (wanted && !present()) {
			return push({ ...page.state, overlays: [...(page.state.overlays ?? []), key] });
		} else if (!wanted && present()) {
			// Not necessarily the top one: closing it closes what it opened.
			const overlays = page.state.overlays ?? [];
			return go(overlays.indexOf(key) - overlays.length);
		}
	}

	$effect(() => {
		wanted = isOpen();
		if (wanted) setTimeout(() => void serial(sync));
		else void serial(sync);
	});

	$effect(() => {
		const now = present();
		untrack(() => {
			if (had && !now && wanted) {
				wanted = false;
				close();
			}
			had = now;
		});
	});

	// Unmounted while open: a navigation has already left, and its entry is
	// not the current one, so this only acts when the overlay was removed in
	// place.
	$effect(() => () => {
		wanted = false;
		void serial(sync);
	});
}

// ── screens ──────────────────────────────────────────────────────────────

/** Opens a screen below this one; its ‹ comes back here. */
export function goForward(path: ResolvedPathname): Promise<void> {
	return serial(async () => {
		await unwind();
		await goto(path, { state: { from: page.url.pathname }, persistState: true });
	});
}

/**
 * Goes to this screen's parent: back, when the parent is the entry behind;
 * otherwise (a deep link, a reload) by replacing this entry with it.
 */
export function goUp(path: ResolvedPathname): Promise<void> {
	return serial(async () => {
		if (page.state.from === path) return go(-(layers() + 1));
		const state = behind();
		await unwind();
		await goto(path, { replace: true, state, persistState: true });
	});
}

/** Goes back to whichever screen opened this one, or replaces it with `fallback`. */
export function goBack(fallback: ResolvedPathname): Promise<void> {
	return serial(async () => {
		if (page.state.from) return go(-(layers() + 1));
		await unwind();
		await goto(fallback, { replace: true });
	});
}

/** Moves sideways: this entry becomes `path` (switching lists, a joined list). */
export function goAcross(path: ResolvedPathname): Promise<void> {
	return serial(async () => {
		const state = behind();
		await unwind();
		await goto(path, { replace: true, state, persistState: true });
	});
}

/**
 * A link (`<a href>`) cannot pass state, so its arrival records where it came
 * from here. Call once, from the root layout. The replace queues like every
 * other history operation, so an overlay opened right after the link keeps its
 * entry; its own `goto` navigation is ignored here.
 */
export function recordLinkOrigins(): void {
	afterNavigate((navigation) => {
		if (navigation.type === 'link' && navigation.from) {
			const from = navigation.from.url.pathname;
			void serial(() => push({ ...page.state, from }, true));
		}
	});
}
