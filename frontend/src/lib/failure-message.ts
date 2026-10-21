// What a failed request or action says to the user ([D-293]), for every layer
// that words one: the actions' outcomes as much as the state's dialogs.
import { t } from '#lib/i18n/index.js';
import { LocalizedError } from '#lib/localized-error.js';
import { httpStatus } from '#lib/http-status.js';

/** A browser's own words for a fetch that never got an answer. */
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror/i;

/** A fetch that never got an answer, in the browser's own words. */
export function isNetworkFailure(e: unknown): boolean {
	return e instanceof TypeError && NETWORK_FAILURE.test(e.message);
}

/** The app's own failure: no server's answer, no copy of its own, no lost connection. */
export function isAppError(e: unknown): boolean {
	return !(e instanceof LocalizedError) && httpStatus(e) === undefined && !isNetworkFailure(e);
}

/**
 * What a failed action says ([D-293]): a cause the user can act on in their
 * language, never the server's or the SDK's English. A response's status says
 * which; a message is shown as thrown only when it is the app's own, a
 * `LocalizedError` (the passkey and OIDC ceremonies throw them).
 */
export function failureMessage(e: unknown): string {
	if (e instanceof LocalizedError) return e.message;
	const status = httpStatus(e);
	if (status !== undefined) {
		if (status === 0) return t('common_error_connection');
		if (status === 401) return t('common_error_session');
		if (status === 429) return t('common_error_rate_limited');
		return t('common_error');
	}
	if (isNetworkFailure(e)) return t('common_error_connection');
	return t('common_error');
}
