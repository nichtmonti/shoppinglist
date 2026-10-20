import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	expect,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page
} from '@playwright/test';
import { SUPERUSER } from '../server';

// Shared flows for the E2E harnesses: accounts, lists, views, a second device,
// the stored session, and the sync engine's own state.
//
// The barcode stub (FAKE_BARCODE / stubBarcodeLookup) also
// serves csp.spec.ts — the two must resolve the SAME product so the CSP run
// exercises the exact code path the scan suite pins.

/** The virtual device's one switch a spec turns: whether the user passes its check. */
export interface VirtualAuthenticator {
	/** `false` fails the next prompt as a dismissal does (NotAllowedError). */
	setUserVerified(verified: boolean): Promise<void>;
}

/**
 * Chromium's CDP virtual WebAuthn device (discoverable + UV), scoped to `page`;
 * it persists across the page's navigations and reloads. Chromium allows one
 * `internal` (platform) authenticator per environment, so a second one on the
 * same page has to be a `usb` security key.
 */
export async function addVirtualAuthenticator(
	page: Page,
	{ transport = 'internal' }: { transport?: 'internal' | 'usb' } = {}
): Promise<VirtualAuthenticator> {
	const client = await page.context().newCDPSession(page);
	await client.send('WebAuthn.enable');
	const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport,
			hasResidentKey: true,
			hasUserVerification: true,
			automaticPresenceSimulation: true,
			isUserVerified: true
		}
	});
	return {
		setUserVerified: async (isUserVerified) => {
			await client.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified });
		}
	};
}

/**
 * Registers a brand-new passkey account and waits for the §9.3 cold-start
 * home. Resolves the device that holds its passkey.
 */
export async function registerAccount(page: Page, nickname: string): Promise<VirtualAuthenticator> {
	const authenticator = await addVirtualAuthenticator(page);
	await page.goto('/');
	await page.getByLabel('Spitzname', { exact: true }).fill(nickname);
	await page.getByRole('button', { name: 'Konto erstellen' }).click();
	await expect(page.getByText('Willkommen!')).toBeVisible({ timeout: 15_000 });
	return authenticator;
}

/**
 * Creates a list via the §7.5 "+ Neue Liste" flow (online-only) and waits for
 * the list route to render. Returns the list URL.
 */
export async function createList(page: Page, name: string): Promise<string> {
	await page.getByRole('button', { name: 'Neue Liste' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Neue Liste' });
	await dialog.getByLabel('Name der Liste').fill(name);
	await dialog.getByRole('button', { name: 'Neue Liste' }).click();
	await expect(page).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
	// Scope to the ListSwitcher trigger button: the list page also carries a
	// visually-hidden <h1> with the same name (for AT), so a bare getByText
	// would match two elements and trip Playwright's strict-mode violation.
	// Exact: the ⋮ beside it is „Aktionen für ‹name›" ([D-271]).
	await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
	return page.url();
}

/**
 * The open share sheet's invite link, created first when the list has none:
 * opening the sheet never mints one ([D-330]). `create` is „Link erstellen" in
 * the page's language.
 */
export async function showInviteLink(page: Page, create = 'Link erstellen'): Promise<Locator> {
	const link = page.getByTestId('invite-link');
	const createButton = page.getByRole('button', { name: create, exact: true });
	await expect(link.or(createButton)).toBeVisible();
	if (await createButton.isVisible()) await createButton.click();
	await expect(link).toBeVisible();
	return link;
}

/**
 * Reads the §7.1 invite link out of the open list's share sheet, creating it
 * when the list has none. Leaves the sheet closed again via Escape.
 */
export async function inviteLinkFor(page: Page): Promise<string> {
	await page.getByTestId('list-menu').click();
	await page.getByRole('button', { name: 'Teilen & Mitglieder' }).click();
	const link = await (await showInviteLink(page)).locator('span').innerText();
	await page.keyboard.press('Escape');
	return link;
}

/**
 * Shares `owner`'s currently-open list with an already-registered `joiner`
 * (§7.5/§7.6 — both online-only). Leaves the joiner on the list route.
 */
export async function shareListWith(owner: Page, joiner: Page): Promise<void> {
	const inviteLink = await inviteLinkFor(owner);
	await joiner.goto(inviteLink);
	await joiner.getByRole('button', { name: 'Beitreten' }).click();
	await expect(joiner).toHaveURL(/\/list\/[^/]+$/, { timeout: 15_000 });
}

// The view is a Dexie-backed pref (`list_view`, #lib/state/prefs): a toggle
// click writes it asynchronously, and the page re-renders only once the live
// query sees the committed write. So the click alone proves nothing — both
// helpers wait until the page RENDERS the view asked for, which also means the
// pref is committed before a caller navigates away. A probe that holds in both
// views (the app bar's item-sort) would otherwise pass while the page still
// shows the old view.

/** Switches to the list view (the only place items are added, §9.1). */
export async function openListView(page: Page): Promise<void> {
	await page.getByTestId('view-toggle-list').click();
	// The add bar exists in the list view only.
	await expect(page.getByRole('combobox', { name: 'Artikel hinzufügen' })).toBeVisible();
}

/** Picks the item order in the app bar's sort menu. Both views start by
 *  category ([D-115]), where rows sit under aisle headers and carry no aisle
 *  chip; a spec about the chip picks A–Z first. The choice applies to both
 *  views ([D-115]) and is a device setting: each device of a spec picks it. */
export async function chooseItemSort(page: Page, order: 'az' | 'category'): Promise<void> {
	await page.getByTestId('item-sort').click();
	await page.getByRole('menuitemradio', { name: order === 'az' ? 'A–Z' : 'Kategorie' }).click();
	await expect(page.getByTestId('item-sort')).toHaveAttribute(
		'aria-label',
		order === 'az' ? /A–Z/ : /Kategorie/
	);
}

/** Switches to the shop view (the only place items are checked off, §9.1). */
export async function openShopView(page: Page): Promise<void> {
	await page.getByTestId('view-toggle-shop').click();
	await expect(page.getByTestId('view-toggle-shop')).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('combobox', { name: 'Artikel hinzufügen' })).toHaveCount(0);
}

/** Types a name into the add box and submits it via Enter (§9). */
export async function addItemByTyping(page: Page, name: string): Promise<void> {
	const input = page.getByRole('combobox', { name: 'Artikel hinzufügen' });
	await input.fill(name);
	await input.press('Enter');
}

/** The active-list row for an item name (A→Z mode). */
export function itemRow(page: Page, name: string) {
	return page.locator('[data-testid="row"]').filter({ hasText: name });
}

// ---- a second device on the same account ----
//
// A second browser context seeded with the first's persisted `{token, record}`
// blob (IndexedDB `einkaufsliste`/`kv`/`pb_auth`, #lib/idb.ts + #lib/pb.ts).
// That is the state a real second device is in after its own passkey login,
// without a second WebAuthn ceremony, invite or list. Its Dexie mirror starts
// empty, so whatever it shows came from the server — the cheapest proof that
// a write was accepted rather than only stored locally (a reload of the first
// device proves nothing: Dexie persists).

/** The page's persisted auth blob (`{token, record}` JSON, or '' when signed out). */
export async function readAuthBlob(page: Page): Promise<string> {
	return page.evaluate(async () => {
		// No version argument: the store is Dexie-managed, and Dexie scales its
		// version, so this opens whatever version the app created.
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('einkaufsliste');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return new Promise<string>((resolve) => {
			const r = db.transaction('kv', 'readonly').objectStore('kv').get('pb_auth');
			r.onsuccess = () => resolve((r.result as string) ?? '');
		});
	});
}

/** Replaces the page's persisted auth blob; the app reads it on its next boot. */
export async function writeAuthBlob(page: Page, blob: string): Promise<void> {
	await page.evaluate(async (value) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('einkaufsliste');
			// A page the app has not booted on yet has no `kv` store.
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise<void>((resolve) => {
			const tx = db.transaction('kv', 'readwrite');
			tx.objectStore('kv').put(value, 'pb_auth');
			tx.oncomplete = () => resolve();
		});
	}, blob);
}

/**
 * Opens a fresh context signed in as `from`'s account and leaves it on the
 * lists home. Close the returned context when done.
 */
export async function openSameAccountDevice(
	browser: Browser,
	from: Page
): Promise<{ context: BrowserContext; page: Page }> {
	const blob = await readAuthBlob(from);
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto('/');
	await writeAuthBlob(page, blob);
	await page.reload();
	return { context, page };
}

// ---- shared barcode-scan stub (scan.spec.ts + csp.spec.ts) ----

/** The barcode the page-level fake scanner "scans". */
export const FAKE_BARCODE = '4006381333931';

// A REAL photo on the photo route, not a stubbed URL. Product photos are
// stored by the backend and served from our own origin ([D-21]), and the push
// route takes no other image_url ([D-266]). It has to be real: the service
// worker claims every photo request (frontend/src/service-worker/index.ts),
// and requests a service worker issues are not interceptable by
// context.route. seedProductPhoto stores it.
const FAKE_PHOTO_TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0';
export const FAKE_IMAGE_URL = `/api/barcode/photo/${FAKE_PHOTO_TOKEN}`;

/** Stores FAKE_IMAGE_URL's photo in the barcode cache through the superuser
 *  API, once per database; concurrent workers race safely on the unique
 *  barcode index. */
async function seedProductPhoto(request: APIRequestContext): Promise<void> {
	const auth = await request.post('/api/collections/_superusers/auth-with-password', {
		data: { identity: SUPERUSER.email, password: SUPERUSER.password }
	});
	expect(auth.ok(), 'the functional server runs with E2E_SUPERUSER').toBe(true);
	const headers = { Authorization: ((await auth.json()) as { token: string }).token };
	const seeded = async () => {
		const res = await request.get('/api/collections/barcode_cache/records', {
			headers,
			params: { filter: `photo_token='${FAKE_PHOTO_TOKEN}'` }
		});
		return ((await res.json()) as { totalItems: number }).totalItems > 0;
	};
	if (await seeded()) return;
	await request.post('/api/collections/barcode_cache/records', {
		headers,
		multipart: {
			barcode: FAKE_BARCODE,
			name: 'Testprodukt Sonnencreme',
			category_slug: 'personal_care',
			found: 'true',
			fetched_at: new Date().toISOString(),
			photo_token: FAKE_PHOTO_TOKEN,
			photo: {
				name: 'photo.png',
				mimeType: 'image/png',
				buffer: readFileSync(
					resolve(import.meta.dirname, '../../frontend/static/icons/icon-192.png')
				)
			}
		}
	});
	expect(await seeded(), 'the product photo is in the barcode cache').toBe(true);
}

/** Stubs the authenticated /api/barcode/* proxy to resolve FAKE_BARCODE, with
 *  its photo seeded on the server. */
export async function stubBarcodeLookup(context: BrowserContext): Promise<void> {
	await seedProductPhoto(context.request);
	await context.route('**/api/barcode/*', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				name: 'Testprodukt Sonnencreme',
				image_url: FAKE_IMAGE_URL,
				category_slug: 'personal_care'
			})
		})
	);
}

// Forcing an expired session for the re-auth journeys (reauth.spec.ts,
// e2e/oidc/oidc-only.spec.ts).
//
// PocketBase's client-side `authStore.isValid` only decodes the JWT's `exp`
// claim locally (no signature check, no network) — see pocketbase.es.mjs's
// isTokenExpired — so a syntactically-valid, unsigned, already-expired JWT is
// enough to force that state without waiting out the real 90-day window
// (§5.6). The persisted blob (IndexedDB `einkaufsliste`/`kv`/`pb_auth`,
// #lib/idb.ts + #lib/pb.ts) is `{token, record}` — the PocketBase SDK's own
// AsyncAuthStore.save() serialization — so the account's `record` (nickname)
// survives untouched; only its `token` is swapped for an expired one.
function fakeExpiredJwt(): string {
	const seg = (obj: unknown) =>
		btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const header = seg({ alg: 'HS256', typ: 'JWT' });
	const payload = seg({ exp: Math.floor(Date.now() / 1000) - 3600 });
	return `${header}.${payload}.fake-signature`;
}

export async function expireStoredToken(page: Page): Promise<void> {
	const { record } = JSON.parse(await readAuthBlob(page)) as { record: unknown };
	await writeAuthBlob(page, JSON.stringify({ token: fakeExpiredJwt(), record }));
}

// ---- history ----

/**
 * The system back over an open sheet, dialog, menu (`overlays`) or arrange
 * mode (`mode`). The layer's history entry is pushed a task after it shows
 * (#lib/history-layers), so a back issued as soon as it is visible can leave
 * the screen instead; this waits until the current entry carries the layer
 * and has settled across two reads (a menu item opening a dialog pops the
 * menu's entry, which carries an overlay too, before it pushes the dialog's).
 */
export async function backOverLayer(page: Page, layer: 'overlays' | 'mode'): Promise<void> {
	let last = '';
	await expect
		.poll(async () => {
			const now = await page.evaluate(() => JSON.stringify(history.state ?? null));
			const settled = now === last && now.includes(layer);
			last = now;
			return settled;
		})
		.toBe(true);
	await page.goBack();
}

// ---- the sync engine, observed from outside ----

/**
 * Echoes the page's errors and `[sync]` logs to the test output, tagged with
 * `label`: the engine swallows a failed cycle into console.error, and
 * Playwright otherwise shows browser console only inside traces.
 */
export function tapSyncConsole(page: Page, label: string): void {
	page.on('console', (msg) => {
		if (msg.type() === 'error' || msg.text().startsWith('[sync]')) {
			console.log(`[${label}] ${msg.text()}`);
		}
	});
}

/**
 * The row count of one of the sync engine's Dexie stores, read straight out
 * of IndexedDB (`einkaufsliste_sync`) — what is stored, whether or not any
 * screen shows it.
 */
export async function storeCount(page: Page, store: string): Promise<number> {
	return page.evaluate(
		(name) =>
			new Promise<number>((resolve, reject) => {
				const req = indexedDB.open('einkaufsliste_sync');
				req.onsuccess = () => {
					const db = req.result;
					const query = db.transaction(name).objectStore(name).count();
					query.onsuccess = () => {
						resolve(query.result);
						db.close();
					};
					query.onerror = () => reject(query.error);
				};
				req.onerror = () => reject(req.error);
			}),
		store
	);
}

/**
 * Switches off conditional mediation (passkey autofill) on `page`. CDP's
 * virtual authenticator answers a conditional request on its own, so without
 * this the auth screen a sign-out lands on signs straight back in.
 * `acrossNavigations` installs it as an init script for every later document;
 * otherwise it holds for the current document only.
 */
export async function disableConditionalMediation(
	page: Page,
	{ acrossNavigations = false }: { acrossNavigations?: boolean } = {}
): Promise<void> {
	const off = () => {
		PublicKeyCredential.isConditionalMediationAvailable = async () => false;
	};
	if (acrossNavigations) await page.addInitScript(off);
	else await page.evaluate(off);
}
