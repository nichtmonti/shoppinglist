import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/pb.js', async () => (await import('#lib/test-kit/pb-mock.js')).pbModuleMock());

import { anySignal, apiJson } from './http';
import { failureOf } from './health';

const opts = { label: 'sync/digest', timeoutMs: 1_000 };
const failure = (fetch: () => Promise<Response>) => {
	vi.stubGlobal('fetch', vi.fn(fetch));
	return apiJson('/api/sync/digest', opts).catch((e: unknown) => e);
};

describe('apiJson', () => {
	afterEach(() => vi.unstubAllGlobals());

	// [D-296] The status tells no answer from the app's own failure (health.ts).
	it('throws status 0 for a request that got no answer', async () => {
		const error = await failure(() => Promise.reject(new TypeError('Failed to fetch')));
		expect(error).toMatchObject({ status: 0, message: 'sync/digest failed: no answer' });
		expect(failureOf(error)).toBe('connection');
	});

	it('throws status 0 for a body that does not arrive or is no JSON', async () => {
		const cut = new Response(
			new ReadableStream({
				start: (c) => c.error(new DOMException('timed out', 'TimeoutError'))
			})
		);
		const portal = new Response('<!doctype html><title>Log in to the Wi-Fi</title>');
		for (const resp of [cut, portal]) {
			const error = await failure(() => Promise.resolve(resp));
			expect(error).toMatchObject({ status: 0 });
			expect(failureOf(error)).toBe('connection');
		}
	});

	it('throws the status of an answer that refused', async () => {
		const error = await failure(() => Promise.resolve(new Response(null, { status: 503 })));
		expect(error).toMatchObject({ status: 503 });
		expect(failureOf(error)).toBe('server');
	});
});

// [D-341] Below Safari 17.4 and Chrome 116 there is no AbortSignal.any; the
// sync engine must still stop on either signal there.
describe('anySignal without AbortSignal.any', () => {
	const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
	afterEach(() => {
		Object.defineProperty(AbortSignal, 'any', native);
	});

	it('aborts with the first source, and with one already aborted', () => {
		// As the browsers below the floor: no such method.
		Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
		const a = new AbortController();
		const b = new AbortController();
		const combined = anySignal([a.signal, b.signal]);
		expect(combined.aborted).toBe(false);
		b.abort('stopped');
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe('stopped');

		expect(anySignal([AbortSignal.abort('gone'), a.signal]).aborted).toBe(true);
	});
});
