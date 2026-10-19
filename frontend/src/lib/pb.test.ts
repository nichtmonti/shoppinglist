// pb.ts's whole-body rule: the SDK reads a 200 it could not finish as `{}`,
// so a response cut short has to fail before the SDK sees it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pb } from './pb';

afterEach(() => vi.unstubAllGlobals());

function answerWith(body: BodyInit) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } }))
	);
}

describe('pb.send', () => {
	it('fails on a 200 whose body was cut short, instead of answering {}', async () => {
		answerWith(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"passkeys":{"ena'));
					controller.error(new TypeError('network error'));
				}
			})
		);

		await expect(pb.send('/api/auth/methods', { requestKey: null })).rejects.toMatchObject({
			status: 0
		});
	});

	it('answers a whole body as before', async () => {
		answerWith('{"passkeys":{"enabled":true}}');

		await expect(pb.send('/api/auth/methods', { requestKey: null })).resolves.toEqual({
			passkeys: { enabled: true }
		});
	});
});
