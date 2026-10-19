// happy-dom (the client project): the token comes out of window.location.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearJoinToken, joinToken } from './join-token';

// §7.6: the invite link is `<origin>/join#<token>`.
describe('joinToken', () => {
	afterEach(() => {
		clearJoinToken();
		window.location.hash = '';
	});

	// [D-295] Until the join: „Open in Safari" from an in-app browser, or a
	// copied address, must carry the invitation on.
	it('reads the token and leaves it in the address bar', () => {
		window.location.hash = '#good-token';
		expect(joinToken()).toBe('good-token');
		expect(window.location.hash).toBe('#good-token');
	});

	it('is still there after a reload of the tab ([D-292])', async () => {
		window.location.hash = '#good-token';
		joinToken();

		// A fresh module is a reloaded page: only the tab's storage carries over.
		vi.resetModules();
		const reloaded = await import('./join-token');
		expect(reloaded.joinToken()).toBe('good-token');
	});

	it('takes a new link over the one it kept', () => {
		window.location.hash = '#first';
		joinToken();
		window.location.hash = '#second';
		expect(joinToken()).toBe('second');
		expect(joinToken()).toBe('second');
	});

	it('is gone once cleared and the join has replaced the address', () => {
		window.location.hash = '#once';
		joinToken();
		clearJoinToken();
		window.location.hash = '';
		expect(joinToken()).toBe('');
	});
});
