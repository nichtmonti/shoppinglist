import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/pb.js', async () => (await import('#lib/test-kit/pb-mock.js')).pbModuleMock());

import {
	describeError,
	reportClientError,
	reportUncaught,
	resetClientErrorsForTest
} from './client-errors';
import { handleError } from '../hooks.client';

describe('client error reporting', () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let assign: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		resetClientErrorsForTest();
		fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);
		vi.stubGlobal('navigator', { userAgent: 'test-agent' });
		const store = new Map<string, string>();
		vi.stubGlobal('sessionStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v)
		});
		assign = vi.fn();
		vi.stubGlobal('location', { assign, pathname: '/list/abc' });
	});

	it('an uncaught error is reported; a cancelled request or one with no connection is not', () => {
		reportUncaught(Object.assign(new Error('aborted'), { isAbort: true }));
		reportUncaught(new DOMException('gone', 'AbortError'));
		reportUncaught(Object.assign(new Error('Failed to fetch'), { status: 0 }));
		expect(fetchMock).not.toHaveBeenCalled();

		reportUncaught(new DOMException('quota', 'QuotaExceededError'));
		expect(fetchMock).toHaveBeenCalledOnce();
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toMatchObject({
			message: 'QuotaExceededError: quota',
			path: '/list/abc',
			context: 'uncaught'
		});
	});

	it('describes an Error by name and message, anything else as a string', () => {
		expect(describeError(new TypeError('x is undefined')).message).toBe(
			'TypeError: x is undefined'
		);
		expect(describeError('boom')).toEqual({ message: 'boom', stack: '' });
	});

	it('handleError reports to the server and hands the page a detail line', () => {
		const result = handleError({
			kind: 'unknown',
			error: new TypeError('x is undefined'),
			event: { route: { id: '/list/[id]' }, url: new URL('https://app.test/list/abc') }
		} as never);

		expect(result).toEqual({ detail: 'TypeError: x is undefined' });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/client-errors');
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
		expect(JSON.parse(init.body as string)).toMatchObject({
			message: 'TypeError: x is undefined',
			route: '/list/[id]',
			path: '/list/abc',
			status: 500,
			agent: 'test-agent'
		});
	});

	it('a 404 is not reported', () => {
		const result = handleError({
			kind: 'framework',
			error: { status: 404, message: 'Not Found: /nope' },
			event: { route: { id: null }, url: new URL('https://app.test/nope') }
		} as never);
		expect(result).toEqual({ detail: 'Not Found: /nope' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('a framework error other than 404 is reported with its own status and message', () => {
		void handleError({
			kind: 'framework',
			error: { status: 503, message: 'Service Unavailable' },
			event: { route: { id: '/' }, url: new URL('https://app.test/') }
		} as never);
		expect(
			JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
		).toMatchObject({
			message: 'Service Unavailable',
			status: 503
		});
	});

	it('the same error is reported once per page session', () => {
		const report = { message: 'E', stack: '', route: '/r', path: '/r', status: 500, context: '' };
		reportClientError(report);
		reportClientError(report);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('a failing report does not throw', () => {
		fetchMock.mockRejectedValue(new Error('offline'));
		expect(() =>
			reportClientError({
				message: 'E2',
				stack: '',
				route: '/r',
				path: '/r',
				status: 500,
				context: ''
			})
		).not.toThrow();
	});

	// [D-202] Safari's "Importing a module script failed." on a navigation.
	const moduleFailure = (url = 'https://app.test/list/abc') =>
		handleError({
			kind: 'unknown',
			error: new TypeError('Importing a module script failed.'),
			event: { route: { id: '/list/[id]' }, url: new URL(url) }
		} as never) as { retrying?: boolean };
	const bodyOf = (call: number) =>
		JSON.parse((fetchMock.mock.calls[call] as [string, RequestInit])[1].body as string);

	it('a route whose code failed to load is reported, then retried as a full page load after a pause', async () => {
		vi.useFakeTimers();
		try {
			expect(moduleFailure().retrying).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(bodyOf(0).context).toContain('sw=none');
			expect(bodyOf(0).context).toContain('swPing=none');
			expect(bodyOf(0).context).toMatch(/pageAge=\d+s/);
			expect(bodyOf(0).context).toContain('recovery=reload-1500ms');
			expect(assign).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1_500);
			expect(assign).toHaveBeenCalledWith('https://app.test/list/abc');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a second failure waits longer, and a third stays on the error page — no loop', async () => {
		vi.useFakeTimers();
		try {
			// Each report goes out once its probe settles; flush it before the next
			// failure, whose identical message would otherwise be de-duplicated.
			moduleFailure();
			await vi.advanceTimersByTimeAsync(0);
			resetClientErrorsForTest();
			moduleFailure();
			await vi.advanceTimersByTimeAsync(0);
			resetClientErrorsForTest();
			expect(moduleFailure().retrying).toBe(false);
			await vi.advanceTimersByTimeAsync(0);
			expect(bodyOf(1).context).toContain('recovery=reload-5000ms');
			expect(bodyOf(2).context).toContain('recovery=none');

			await vi.advanceTimersByTimeAsync(5_000);
			expect(assign).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('any other error is not retried', () => {
		void handleError({
			kind: 'unknown',
			error: new TypeError('x is undefined'),
			event: { route: { id: '/list/[id]' }, url: new URL('https://app.test/list/abc') }
		} as never);
		expect(assign).not.toHaveBeenCalled();
	});
});
