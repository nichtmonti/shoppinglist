// The one authorized fetch the sync engine's default transports share: the
// session's bearer token, a timeout, and one answer to a failed status. Not the
// SDK's send: it answers a 2xx body that is not JSON with {} instead of an
// error, and the engine must never read a garbled digest as an empty one.
import { markAuthExpired } from '../auth/state';
import { authHeaders } from '../pb';

export interface ApiFetchOptions {
	/** Names the request in the error message (`<label> failed: <status>`). */
	label: string;
	/**
	 * Every request the engine makes carries a timeout: cycles and drains
	 * serialize behind one another (cycle.ts cycleTail), so a request that never
	 * settles would stall sync until a reload.
	 */
	timeoutMs: number;
	method?: 'GET' | 'POST';
	/** Sent as JSON. */
	body?: unknown;
}

/** An error for a non-2xx answer; `status` is what isAuthRejected reads. */
export type ApiError = Error & { status: number };

/**
 * Fetch one of the app's own routes as the signed-in account and return the
 * response, which is always 2xx. A non-2xx answer throws an ApiError carrying
 * the status, so a caller can tell a rejected token (401) from a transient
 * failure. A 401 also marks the session expired (§5.8): the SDK's auth store
 * does not notice a token the server stopped accepting.
 */
export async function apiFetch(path: string, opts: ApiFetchOptions): Promise<Response> {
	const headers: Record<string, string> = authHeaders();
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
	const resp = await fetch(path, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		signal: AbortSignal.timeout(opts.timeoutMs)
	});
	if (!resp.ok) {
		if (resp.status === 401) markAuthExpired();
		const error: ApiError = Object.assign(new Error(`${opts.label} failed: ${resp.status}`), {
			status: resp.status
		});
		throw error;
	}
	return resp;
}
