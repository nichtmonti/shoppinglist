// The one authorized fetch the sync engine's default transports share: the
// session's bearer token, a timeout, and one answer to a failed status.
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

/** An error for a non-2xx answer, or status 0 for none; `status` is what
 *  isAuthRejected and the sync status (health.ts) read. */
export type ApiError = Error & { status: number };

/**
 * Fetch one of the app's own routes as the signed-in account and return the
 * response, which is always 2xx. A non-2xx answer throws an ApiError carrying
 * the status, so a caller can tell a rejected token (401) from a transient
 * failure, and no answer (the network, the timeout) one with status 0, as
 * PocketBase's SDK does: an error without a status is then the app's own. A
 * 401 also marks the session expired (§5.8): the SDK's auth store does not
 * notice a token the server stopped accepting.
 */
export async function apiFetch(path: string, opts: ApiFetchOptions): Promise<Response> {
	const headers: Record<string, string> = authHeaders();
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
	const resp = await fetch(path, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		signal: AbortSignal.timeout(opts.timeoutMs)
	}).catch((cause: unknown) => {
		const error: ApiError = Object.assign(new Error(`${opts.label} failed: no answer`, { cause }), {
			status: 0
		});
		throw error;
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
