import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimReload, isModuleLoadError } from './module-recovery';

describe('module-load failures ([D-202])', () => {
	it('recognises each engine’s wording', () => {
		expect(isModuleLoadError('TypeError: Importing a module script failed.')).toBe(true);
		expect(
			isModuleLoadError('TypeError: Failed to fetch dynamically imported module: https://x/a.js')
		).toBe(true);
		expect(isModuleLoadError('TypeError: error loading dynamically imported module')).toBe(true);
		expect(isModuleLoadError('TypeError: x is undefined')).toBe(false);
	});

	describe('claimReload', () => {
		let store: Map<string, string>;
		beforeEach(() => {
			store = new Map();
			vi.stubGlobal('sessionStorage', {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v)
			});
		});

		it('allows two retries per path per minute: after 1.5 s, then after 5 s', () => {
			const url = new URL('https://app.test/list/a');
			expect(claimReload(url, 1_000_000)).toBe(1_500);
			expect(claimReload(url, 1_010_000)).toBe(5_000);
			expect(claimReload(url, 1_020_000)).toBeNull();
			expect(claimReload(new URL('https://app.test/list/b'), 1_020_000)).toBe(1_500);
			// A minute after the first retry the path gets a fresh pair.
			expect(claimReload(url, 1_061_000)).toBe(1_500);
		});

		it('refuses without sessionStorage rather than risk a loop', () => {
			vi.stubGlobal('sessionStorage', {
				getItem: () => {
					throw new Error('denied');
				}
			});
			expect(claimReload(new URL('https://app.test/list/a'))).toBeNull();
		});
	});
});
