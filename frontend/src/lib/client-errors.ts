// Uncaught client errors, sent to the server log ([D-197]), since on a phone
// nobody sees the browser console. hooks.client.ts hands every such error here.
import { appVersion } from '#lib/config.js';
import { authHeaders } from '#lib/pb.js';

interface ClientErrorReport {
	message: string;
	stack: string;
	route: string;
	path: string;
	status: number;
	// Extra evidence for a failure class, e.g. which module URLs failed ([D-202]).
	context: string;
	version: string;
	agent: string;
}

/** A one-line description of anything thrown, for the report and the error page. */
export function describeError(error: unknown): { message: string; stack: string } {
	if (error instanceof Error) {
		return { message: `${error.name}: ${error.message}`, stack: error.stack ?? '' };
	}
	return { message: String(error), stack: '' };
}

// One report per distinct error per page session: an error that re-throws on
// every render must not use up the route's rate limit on itself.
const sent = new Set<string>();

/** Fire-and-forget: a failed report must never become a second error. */
export function reportClientError(report: Omit<ClientErrorReport, 'version' | 'agent'>): void {
	const key = `${report.route}|${report.message}`;
	if (sent.has(key)) return;
	sent.add(key);
	const body: ClientErrorReport = {
		...report,
		stack: report.stack.slice(0, 4000),
		context: report.context.slice(0, 1000),
		version: appVersion ?? 'dev',
		agent: navigator.userAgent
	};
	void fetch('/api/client-errors', {
		method: 'POST',
		keepalive: true,
		headers: {
			'Content-Type': 'application/json',
			...authHeaders()
		},
		body: JSON.stringify(body)
	}).catch(() => {});
}

/**
 * Reports an error nothing caught: a rejected promise no one awaited, or a
 * throw in an event handler. SvelteKit's handleError sees only a route's load
 * and render, and on a phone the console is out of sight ([D-197]). A request
 * the app cancelled, or one with no connection, is not an error.
 */
export function reportUncaught(error: unknown): void {
	const e = error as { name?: unknown; isAbort?: unknown; status?: unknown } | null;
	if (e?.name === 'AbortError' || e?.isAbort === true || e?.status === 0) return;
	const { message, stack } = describeError(error);
	reportClientError({
		message,
		stack,
		route: '',
		path: location.pathname,
		status: 0,
		context: 'uncaught'
	});
}

let watching = false;

/** Sends every uncaught error and rejection on this page to reportUncaught,
 *  and to `also`, which can tell the user. */
export function watchUncaughtErrors(also: (error: unknown) => void = () => {}): void {
	if (watching || typeof window === 'undefined') return;
	watching = true;
	const uncaught = (error: unknown) => {
		reportUncaught(error);
		also(error);
	};
	window.addEventListener('unhandledrejection', (event) => uncaught(event.reason));
	// A resource that failed to load fires `error` too, without an error.
	window.addEventListener('error', (event) => {
		if (event.error !== undefined) uncaught(event.error);
	});
}

/** Test seam: forget which errors were already sent. */
export function resetClientErrorsForTest(): void {
	sent.clear();
}
