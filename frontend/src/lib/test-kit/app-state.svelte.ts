// A reactive stand-in for `$app/state` and `$app/navigation` in component
// tests, installed for every one by component-setup.ts: assigning
// `page.params` re-renders what reads it, as a client-side navigation does.
//
// Behind it sits a fake browser history, because #lib/history-layers drives
// one: every overlay and mode is an entry, and the ‹ buttons go back over
// them. `goto` writes entries and `page` (`''` is the current URL, as it is for
// a shallow goto, and `replace` overwrites the current entry);
// `historyGo` traverses them and fires popstate, as `history.go` does — the
// setup stubs `history.go` and `history.back` with it, and `historyBack` is
// the system back button. A suite that needs to assert on `goto` mocks
// `$app/navigation` itself and spreads `navigation` under its spy.
interface Entry {
	url: string;
	state: App.PageState;
}

const ORIGIN = 'http://localhost';

export const page = $state<{
	params: Record<string, string>;
	route: { id: string | null };
	state: App.PageState;
	url: URL;
}>({
	params: {},
	route: { id: null },
	state: {},
	// Replaced whole on every navigation, never mutated, as SvelteKit's own is.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	url: new URL('/', ORIGIN)
});

// No navigation is ever in flight here: `goto` lands at once, so this is
// SvelteKit's idle `navigating`, every field null.
export const navigating = { from: null, to: null, type: null, complete: null };

let entries: Entry[] = [{ url: '/', state: {} }];
let index = 0;

function show(): void {
	const entry = entries[index];
	page.state = entry.state;
	page.url = new URL(entry.url, ORIGIN);
}

function push(entry: Entry): void {
	entries = [...entries.slice(0, index + 1), entry];
	index = entries.length - 1;
	show();
}

/** A fresh history holding one entry, `url`. */
export function resetHistory(url = '/'): void {
	entries = [{ url, state: {} }];
	index = 0;
	show();
}

/** The entries' URLs, oldest first, and which one is current. */
export function historyEntries(): { urls: string[]; index: number } {
	return { urls: entries.map((entry) => entry.url), index };
}

export function goto(
	url: string,
	options: { replace?: boolean; shallow?: boolean; state?: App.PageState } = {}
): Promise<void> {
	const entry = { url: url || entries[index].url, state: options.state ?? {} };
	if (options.replace) {
		entries[index] = entry;
		show();
	} else {
		push(entry);
	}
	return Promise.resolve();
}

export function historyGo(delta: number): void {
	const next = index + delta;
	if (delta === 0 || next < 0 || next >= entries.length) return;
	index = next;
	show();
	dispatchEvent(new PopStateEvent('popstate'));
}

/** The system back button. */
export function historyBack(): void {
	historyGo(-1);
}

export function afterNavigate(): void {}

/** Nothing to import: the components under test are loaded already. */
export async function preloadCode(): Promise<void> {}

export const navigation = { goto, afterNavigate, preloadCode };
