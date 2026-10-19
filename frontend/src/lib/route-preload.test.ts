import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preloadCode } = vi.hoisted(() => ({ preloadCode: vi.fn() }));
vi.mock('$app/navigation', () => ({ preloadCode }));
vi.mock('$app/manifest', () => ({
	routes: [
		{ id: '/', page: true, endpoint: false },
		{ id: '/list/[id]', page: true, endpoint: false },
		{ id: '/dev/gallery', page: true, endpoint: false },
		{ id: '/api/health', page: false, endpoint: true }
	]
}));

import { preloadScreens } from './route-preload';

describe('preloadScreens', () => {
	beforeEach(() => {
		preloadCode.mockReset().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { serviceWorker: { controller: {} } });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("imports every screen's code", async () => {
		await preloadScreens();
		expect(preloadCode.mock.calls.map(([id]) => id)).toEqual(['/', '/list/[id]', '/dev/gallery']);
	});

	it('settles when a screen fails to load', async () => {
		preloadCode.mockRejectedValueOnce(new Error('Importing a module script failed.'));
		await expect(preloadScreens()).resolves.toBeUndefined();
		expect(preloadCode).toHaveBeenCalledTimes(3);
	});

	it('leaves the code to the taps without a service worker', async () => {
		vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
		await preloadScreens();
		expect(preloadCode).not.toHaveBeenCalled();
	});
});
