import type { HandleClientError } from '@sveltejs/kit/hooks';
import { describeError, reportClientError, watchUncaughtErrors } from '#lib/client-errors.js';
import {
	claimReload,
	isModuleLoadError,
	moduleFailureContext,
	pageContext,
	probeServiceWorker,
	watchResourceFailures,
	watchServiceWorker
} from '#lib/module-recovery.js';

watchResourceFailures();
watchServiceWorker();
watchUncaughtErrors();

// Every error SvelteKit catches on the client — a route that throws while it
// loads or renders — is reported to the server log and carried to the error
// page as `detail`, so a phone user sees (and can send) what went wrong
// instead of a bare "500 Internal Error" ([D-197]). SvelteKit's own errors
// (`framework`, a 404 among them) arrive as `{ status, message }`; anything
// thrown arrives as itself (`unknown`, status 500). The page's `status` and
// `message` are SvelteKit's defaults: the hook adds only `detail`/`retrying`.
export const handleError: HandleClientError = ({ kind, error, event }) => {
	const status = kind === 'unknown' ? 500 : error.status;
	const { message: detail, stack } =
		kind === 'unknown' ? describeError(error) : { message: error.message, stack: '' };
	if (status === 404) return { detail };
	const report = {
		message: detail,
		stack,
		route: event.route.id ?? '',
		path: event.url.pathname
	};
	if (!isModuleLoadError(detail)) {
		reportClientError({ ...report, status, context: '' });
		return { detail };
	}

	// [D-202] A route whose code failed to load: retried as a full page load
	// after a pause — the failure is transient — and reported with what the
	// page can see of it, the service worker's response time measured now.
	const delay = claimReload(event.url);
	const seen = `${moduleFailureContext()} ${pageContext()}`;
	void probeServiceWorker().then((ping) =>
		reportClientError({
			...report,
			status,
			context: `${seen} swPing=${ping} recovery=${delay === null ? 'none' : `reload-${delay}ms`}`
		})
	);
	if (delay !== null) setTimeout(() => location.assign(event.url.href), delay);
	return { detail, retrying: delay !== null };
};
