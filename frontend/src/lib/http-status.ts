/**
 * The HTTP status an error carries, or undefined when it has none. PocketBase's
 * ClientResponseError and the engine's ApiError (sync/http.ts) both carry one,
 * 0 when no answer came.
 */
export function httpStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}
