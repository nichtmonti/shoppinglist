// Product photos kept for offline when their items arrive ([D-353]), not only
// when a tile first shows one: planning rows are text and shop tiles load
// lazily, so a list planned online would otherwise meet the store offline
// with no pictures. The service worker fills the same cache on a tile's own
// request (§9.2, [D-21]); this asks for the rest with the Cache API's `add`.
import { liveQuery } from 'dexie';
import { db } from '#lib/db.js';
import { PHOTO_CACHE } from '#lib/photo-cache.js';

/** Photos this session has seen in the cache or put there. */
const kept = new Set<string>();
/** Bumped by a sign-out, so a run already under way stops putting photos
 *  into the cache logout deleted. */
let session = 0;
let running: Promise<void> | null = null;
/** A change came in while a run was reading: run once more after it. */
let again = false;

/**
 * Puts every local item's photo the cache lacks into it: when items change,
 * whichever path wrote them (a cycle's pull, a live event, this device), and
 * after each sync cycle, which proves the connection again for a photo that
 * failed offline. Opens the cache only when there is a photo to look for, so
 * a signed-out device does not get an empty one back. One run at a time; a
 * change during a run gets one more.
 */
export function keepPhotos(): Promise<void> {
	if (running) {
		again = true;
		return running;
	}
	running = (async () => {
		do {
			again = false;
			await run();
		} while (again);
	})().finally(() => (running = null));
	return running;
}

/** Keeps photos as items with them change, until the returned stop. */
export function watchPhotos(): () => void {
	const sub = liveQuery(() =>
		db.items.filter((item) => Boolean(item.image_url)).primaryKeys()
	).subscribe({
		next: () => void keepPhotos(),
		error: () => {} // the next cycle runs keepPhotos too
	});
	return () => {
		sub.unsubscribe();
		forgetKeptPhotos();
	};
}

async function run(): Promise<void> {
	if (typeof caches === 'undefined') return;
	const mine = session;
	const urls = new Set<string>();
	await db.items.each((item) => {
		if (item.image_url && !kept.has(item.image_url)) urls.add(item.image_url);
	});
	if (urls.size === 0 || mine !== session) return;
	const cache = await caches.open(PHOTO_CACHE);
	for (const url of urls) {
		if (mine !== session) return;
		if (!(await cache.match(url))) {
			try {
				await cache.add(url);
			} catch {
				continue; // offline again, or the photo is gone: next cycle
			}
		}
		kept.add(url);
	}
}

/** Ends the session's keeping: a new one starts from what the cache holds. */
export function forgetKeptPhotos(): void {
	session += 1;
	kept.clear();
}
