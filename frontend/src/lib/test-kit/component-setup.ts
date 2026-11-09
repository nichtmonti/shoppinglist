// Setup for the `client` vitest project (Svelte component tests).
//
// @testing-library/svelte's own setup and cleanup, which it registers by itself
// only under `globals: true`, are wired here: setup() makes waitFor/findBy* and
// fired events wait for Svelte to flush (act, flushSync); cleanup() unmounts,
// or one test's components stay in the happy-dom document and the next test's
// queries match the wrong element. Its vitest.js entry does the same, but the
// overflow wait below must run after the unmount, ordered against it here.
// Component tests assert against German strings. Paraglide's `baseLocale` is
// 'en' (docs/internals/design.md §12.2), the app's fresh-user default, not a
// constraint on which locale tests assert against. Reset to 'de' before each test so a `setLocale('en')` inside one
// test (e.g. a locale-switch test) can't leak into the next.
import { act, cleanup, configure, setup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { setLocale } from '#lib/i18n/index.js';
import { conflictingClasses } from '#lib/utils.js';

// The default 1000ms is too tight for the first test per file on a slow CI
// runner: the Dexie liveQuery stores that back every component haven't emitted
// their first value yet, so waitFor/findBy* give up before hydration. 5s is
// the same ceiling Sheet.svelte.test.ts already passes manually for the same
// class of problem. Passing cases finish immediately — this only raises the
// polling ceiling.
configure({ asyncUtilTimeout: 5000 });

// happy-dom has no isSecureContext; the tests stand in for a browser at
// localhost, which is one ([D-335]). A test of the other case sets it false.
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

beforeEach(async () => {
	await setup();
	setLocale('de');
	// What a tab keeps for a reload (#lib/safe-storage) is per test.
	sessionStorage.clear();
	// No network: a request nothing stubbed (the failure report a test of an
	// error path sends, [D-197]) fails as offline does, instead of happy-dom
	// connecting to localhost:3000. A test that needs fetch stubs its own.
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.reject(new TypeError('no network in component tests')))
	);
});

// SvelteKit's router does not run under testing-library, and every sheet,
// dialog and menu is a history entry (#lib/history-layers, [D-230]), so the
// router modules are the test kit's fake history in every component test — a
// fresh one per test, with the browser's traversal routed into it. A suite
// that spies on `goto` mocks `$app/navigation` over this (see the kit).
vi.mock('$app/state', () => import('#lib/test-kit/app-state.svelte.js'));
vi.mock(
	'$app/navigation',
	async () => (await import('#lib/test-kit/app-state.svelte.js')).navigation
);

beforeEach(async () => {
	const appState = await import('#lib/test-kit/app-state.svelte.js');
	appState.resetHistory();
	vi.spyOn(history, 'go').mockImplementation((delta = 0) => appState.historyGo(delta));
	vi.spyOn(history, 'back').mockImplementation(appState.historyBack);
});

// [D-146] Every component test doubles as a class-conflict check: any element
// that EVER carries two utilities overriding each other (relative + absolute,
// rounded-chip + rounded-full, …) fails the test that rendered it. Which of the
// two applies is decided by where Tailwind emits them, not by their order in the
// attribute — a sheet-order lottery two past bugs came from, defended only by
// comments until this. A MutationObserver sees every class list the test
// produces, transient states (an open dropdown, a sheet) included, and portals,
// since bits-ui mounts those under document.body too.
const classConflicts = new Map<string, string>();
let classWatch: MutationObserver | null = null;

function recordClassConflicts(el: Element): void {
	const className = el.getAttribute('class');
	if (!className) return;
	const dropped = conflictingClasses(className);
	if (dropped.length > 0)
		classConflicts.set(className, `<${el.tagName.toLowerCase()}> drops [${dropped.join(' ')}]`);
}

function scanClassConflicts(root: Element): void {
	recordClassConflicts(root);
	for (const el of root.querySelectorAll('[class]')) recordClassConflicts(el);
}

function drainClassWatch(records: MutationRecord[]): void {
	for (const r of records) {
		if (r.type === 'attributes' && r.target instanceof Element) recordClassConflicts(r.target);
		for (const node of r.addedNodes) if (node instanceof Element) scanClassConflicts(node);
	}
}

beforeEach(() => {
	classConflicts.clear();
	classWatch = new MutationObserver(drainClassWatch);
	classWatch.observe(document.body, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ['class']
	});
});

afterEach(async () => {
	// Collected BEFORE cleanup (which unmounts everything), asserted after it,
	// so a conflict never leaves this test's components mounted in the next.
	if (classWatch) {
		drainClassWatch(classWatch.takeRecords());
		scanClassConflicts(document.body);
		classWatch.disconnect();
		classWatch = null;
	}
	const conflicts = [...classConflicts].map(([className, what]) => `${what} in "${className}"`);
	await act();
	cleanup();

	// bits-ui's body-scroll-lock schedules a 24ms cleanup timer when the last
	// Dialog closes, on Node's timers; if this file's environment tears down
	// before it fires, resetBodyStyle throws "document is not defined" as an unhandled
	// error. The lock is value-visible — `overflow: hidden` on document.body
	// until the timer fires — so wait for the observable, not for a sleep past
	// its delay. Tests that opened no dialog never see the lock and skip
	// straight through.
	if (document.body.style.overflow === 'hidden') {
		await waitFor(() => {
			expect(document.body.style.overflow).not.toBe('hidden');
		});
	}

	expect(conflicts, 'elements carrying utilities that override each other ([D-146])').toEqual([]);
});
