import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPersistentStorage } from './storage';

describe('requestPersistentStorage', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns false when the Storage Manager API is unavailable', async () => {
		vi.stubGlobal('navigator', {});
		await expect(requestPersistentStorage()).resolves.toBe(false);
	});

	it('returns the grant result when the API is available', async () => {
		vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => true) } });
		await expect(requestPersistentStorage()).resolves.toBe(true);
	});

	it('swallows a rejected persist() call and returns false — best-effort, never blocks boot (§8.8)', async () => {
		vi.stubGlobal('navigator', {
			storage: {
				persist: vi.fn(async () => {
					throw new Error('denied');
				})
			}
		});
		await expect(requestPersistentStorage()).resolves.toBe(false);
	});
});
