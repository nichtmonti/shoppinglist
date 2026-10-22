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
	/** Cancels the request when its owner stops (the loop, a sign-out). */
	signal?: AbortSignal;
	method?: 'GET' | 'POST';
	/** Sent as JSON. */
	body?: unknown;
}

/** An error for a non-2xx answer, or status 0 for none; `status` is what
 *  isAuthRejected and the sync status (health.ts) read. */
type ApiError = Error & { status: number };

/** A combined signal, and `release()` for when the work it guards is done. */
export interface CombinedSignal {
	signal: AbortSignal;
	release: () => void;
}

/**
 * A signal that aborts with the first of `signals` ([D-341]). AbortSignal.any
 * is Safari 17.4 and Chrome 116, above the app's floor (impl-notes, "Supported
 * browser baseline"): below it, the same from a controller and a listener on
 * each source, which `release()` removes, or a long-lived source (the loop's,
 * the session's) would keep one per cycle and request until it aborts.
 */
export function anySignal(signals: AbortSignal[]): CombinedSignal {
	if ('any' in AbortSignal) {
		// eslint-disable-next-line no-restricted-properties -- the one feature-detected use
		return { signal: AbortSignal.any(signals), release() {} };
	}
	const controller = new AbortController();
	const unlink = new AbortController();
	const release = () => unlink.abort();
	const aborted = signals.find((source) => source.aborted);
	if (aborted) {
		controller.abort(aborted.reason);
		return { signal: controller.signal, release };
	}
	for (const source of signals) {
		const forward = () => {
			controller.abort(source.reason);
			release();
		};
		source.addEventListener('abort', forward, { signal: unlink.signal });
	}
	return { signal: controller.signal, release };
}

/** `signal`, or nothing, plus a timeout: whichever comes first aborts. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): CombinedSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? anySignal([signal, timeout]) : { signal: timeout, release() {} };
}

/**
 * Fetch one of the app's own routes as the signed-in account and return its
 * JSON body. A non-2xx answer throws an ApiError carrying the status, so a
 * caller can tell a rejected token (401) from a transient failure. No usable
 * answer throws one with status 0, as PocketBase's SDK does: no response, a
 * body cut off or timed out, or one that is not JSON (a captive portal's
 * page). An error without a status is then the app's own. A 401 also marks the
 * session expired (§5.8): the SDK's auth store does not notice a token the
 * server stopped accepting.
 */
export async function apiJson(path: string, opts: ApiFetchOptions): Promise<unknown> {
	const headers: Record<string, string> = authHeaders();
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
	const noAnswer = (cause: unknown): never => {
		const error: ApiError = Object.assign(new Error(`${opts.label} failed: no answer`, { cause }), {
			status: 0
		});
		throw error;
	};
	const { signal, release } = withTimeout(opts.signal, opts.timeoutMs);
	try {
		const resp = await fetch(path, {
			method: opts.method ?? 'GET',
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal
		}).catch(noAnswer);
		if (!resp.ok) {
			if (resp.status === 401) markAuthExpired();
			const error: ApiError = Object.assign(new Error(`${opts.label} failed: ${resp.status}`), {
				status: resp.status
			});
			throw error;
		}
		return await resp.json().catch(noAnswer);
	} finally {
		release();
	}
}
