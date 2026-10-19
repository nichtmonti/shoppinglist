// happy-dom (the client project): the token comes out of window.location, and
// the router is the test kit's fake history.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { historyEntries, page, resetHistory } from '#lib/test-kit/app-state.svelte.js';
import { clearSetupToken, setupToken } from './setup-link';

/** Opens the tab at `hash`, in the address bar and in the router. */
function open(hash: string): void {
	window.location.hash = hash;
	resetHistory('/' + hash);
}

// [D-241] The setup link the server logs: `<origin>/#setup=<token>`.
describe('setupToken', () => {
	afterEach(() => {
		clearSetupToken();
		window.location.hash = '';
	});

	it('reads the token once and takes it out of the URL through the router', () => {
		open('#setup=from-the-log');
		expect(setupToken()).toBe('from-the-log');
		// The entry is replaced, and `page.url` no longer holds the token.
		expect(historyEntries().urls).toEqual(['/']);
		expect(page.url.hash).toBe('');
		// Still in hand for a second read.
		window.location.hash = '';
		expect(setupToken()).toBe('from-the-log');
	});

	it('is still there after a reload of the tab ([D-292])', async () => {
		open('#setup=from-the-log');
		setupToken();

		// A fresh module is a reloaded page: only the tab's storage carries over.
		vi.resetModules();
		window.location.hash = '';
		const reloaded = await import('./setup-link');
		expect(reloaded.setupToken()).toBe('from-the-log');
	});

	it('is null without one, and leaves another fragment alone', () => {
		open('#something-else');
		expect(setupToken()).toBeNull();
		expect(historyEntries().urls).toEqual(['/#something-else']);
	});

	it('is gone once cleared', () => {
		open('#setup=once');
		expect(setupToken()).toBe('once');
		window.location.hash = '';
		clearSetupToken();
		expect(setupToken()).toBeNull();
	});
});
