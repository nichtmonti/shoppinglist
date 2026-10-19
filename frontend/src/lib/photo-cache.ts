/**
 * The Cache Storage bucket holding product photos ([D-21]), shared by the
 * service worker that fills it and `logout()` that empties it, so the two
 * cannot drift into a logout that clears nothing.
 *
 * Not versioned like the shell cache: photos are immutable and unrelated to
 * the build, so a versioned name would empty it on every deploy.
 */
export const PHOTO_CACHE = 'photos';

/** Where the server serves a product photo (internal/barcode's
 *  photoPathPrefix): under the origin's root like every /api route, not under
 *  the app's scope. */
export const PHOTO_PATH = '/api/barcode/photo/';
