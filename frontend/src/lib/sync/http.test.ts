import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/pb.js', async () => (await import('#lib/test-kit/pb-mock.js')).pbModuleMock());

import { apiFetch } from './http';
import { failureOf } from './health';

const opts = { label: 'sync/digest', timeoutMs: 1_000 };

describe('apiFetch', () => {
	afterEach(() => vi.unstubAllGlobals());

	// [D-296] The status tells no answer from the app's own failure (health.ts).
	it('throws status 0 for a request that got no answer', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		const error = await apiFetch('/api/sync/digest', opts).catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 0, message: 'sync/digest failed: no answer' });
		expect(failureOf(error)).toBe('connection');
	});

	it('throws the status of an answer that refused', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
		const error = await apiFetch('/api/sync/digest', opts).catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 503 });
		expect(failureOf(error)).toBe('server');
	});
});
