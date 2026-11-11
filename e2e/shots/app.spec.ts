import type { Page } from '@playwright/test';
import {
	addVirtualAuthenticator,
	disableConditionalMediation,
	showInviteLink
} from '../tests/helpers';
import { expect, test } from '../tests/fixtures';
import { aimCamera, installCamera, lowerCamera } from '../tests/camera';
import { compose, record } from './clip';
import {
	createAccount,
	createList,
	device,
	msg,
	settle,
	shoot,
	type Locale,
	type Theme
} from './shots';

// The real app, told as one household's story — for the README and for
// anyone who wants to see a change in context. Images, in story order:
//
//   1-signin   no password, no email      5-found    …the product it found
//   2-home     the household's lists      6-list     the list: quantities, notes, a photo
//   3-suggest  planning: typing suggests  7-detail   one item's quantity, note, aisle
//   4-scan     …or scanning a barcode     8-share    inviting by link or QR code
//                                         9-shop     in the store: tiles in aisle order
//  10-import  a list from another app, pasted   11-review  what it becomes, before anything is added
//  12-done    the shop view's bought items      13-settings  the settings, from the top
//  14-menu    a list's ⋮ sheet                  15-categories  its aisles, arranged
//  16-previous  what the list bought before
//
// and clip.webp: two phones, Alice's and Bob's, from an empty list to a
// shopped one — sharing, joining, adding and ticking off, each change seen
// arriving on the other phone. Its own test, on accounts of its own: the
// clip's list holds only what is added on camera, so every item is one the
// viewer saw arrive.
//
// The scan is real from the camera on: camera.ts feeds a real EAN-13 into
// getUserMedia, the app's decoder reads it, and the server looks it up at Open
// Food Facts and stores its photo — so this needs the container's internet.
//
// One household per locale, signed up in that locale, so its lists get that
// locale's aisle names and its items that language's dictionary categories.
// Every selector comes from the app's own messages (msg) or a test id, so the
// same script drives both languages. Images: <locale>/<theme>/<n>-<screen>.png.
//
// SHOTS_LOCALES and SHOTS_THEMES narrow a run (space-separated; default all),
// and SHOTS_WANT to named images (below).

/** Barilla Spaghetti Nº5, 500 g: a product Open Food Facts has with a photo
 *  and a short name in both languages, so its tile shows the whole name. */
const BARCODE = '8076800195057';

interface Household {
	nickname: string;
	/** Joins the main list through its invite link. */
	partner: string;
	main: {
		name: string;
		items: string[];
		/** Quantities and notes, set in each item's detail sheet. */
		details: { name: string; quantity?: string; note?: string }[];
		checked: string[];
		/** Its detail sheet is the detail shot. */
		open: string;
	};
	others: { name: string; items: string[] }[];
	/** Typed into the add box for the suggestions shot. */
	typing: string;
	/** Pasted into the import screen ([D-254]): a list shared from another
	 *  app, in the shape „Die Einkaufsliste“ shares it. */
	pasted: string;
	/** The two-phone clip: its two people (labels and nicknames), what each
	 *  adds and later takes, Alice's typed with an amount to show it read off
	 *  as the quantity ([D-285]), and its subtitles in order. */
	clip: {
		labels: [string, string];
		alice: { name: string; amount: string };
		bob: string;
		captions: [string, string, string, string, string, string, string, string, string, string];
	};
}

const HOUSEHOLDS: Record<Locale, Household> = {
	// Lower case, as the English dictionary writes its entries: a typed name
	// that matches one lands as the dictionary's, so capitals would mix.
	en: {
		nickname: 'Anna',
		partner: 'Ben',
		main: {
			name: 'Groceries',
			items: [
				'milk',
				'bread',
				'bananas',
				'tomatoes',
				'cheese',
				'yogurt',
				'coffee',
				'dish soap',
				'toothpaste',
				'apples',
				'eggs',
				'oats',
				'butter'
			],
			details: [
				{ name: 'milk', quantity: '2 l' },
				{ name: 'cheese', quantity: '200 g', note: 'mature, from the counter' },
				{ name: 'bananas', note: 'not too ripe' },
				{ name: 'eggs', quantity: '10' },
				{ name: 'tomatoes', quantity: '6' },
				{ name: 'yogurt', quantity: '4', note: 'plain' }
			],
			checked: ['bread', 'coffee', 'apples'],
			open: 'cheese'
		},
		others: [
			{ name: 'Pharmacy', items: ['plasters', 'shampoo', 'sunscreen'] },
			{ name: 'Barbecue on Saturday', items: ['sausages', 'charcoal', 'potato salad', 'beer'] }
		],
		typing: '2 be',
		pasted:
			'Weekend\n\n[Fruit - Vegetables]\nmango\n2 red peppers\n1 kg potatoes\n\n[Bakery]\nbagels\n\n[Dairy]\n1 l oat milk\nfeta\n\n[Breakfast]\nmaple syrup\nchia seeds\n',
		clip: {
			labels: ['Alice', 'Bob'],
			alice: { name: 'milk', amount: '3 liter' },
			bob: 'coffee',
			captions: [
				'Alice starts a list. Bob has none yet.',
				'She shares it by link or QR code.',
				'Bob opens the invite and joins, and Alice sees him arrive.',
				'To plan, Alice switches to “Editing”.',
				'She types “3 liter milk”: milk, 3 liter, appears on Bob’s phone.',
				'Bob switches to “Editing” too, and adds coffee.',
				'In the store, both switch to “Shopping”.',
				'Alice takes the milk, and it’s checked off on Bob’s phone.',
				'No signal for Bob: his tick waits, counted in yellow at the top.',
				'The signal is back: the tick goes through. All done.'
			]
		}
	},
	de: {
		nickname: 'Anna',
		partner: 'Ben',
		main: {
			name: 'Einkauf',
			items: [
				'Milch',
				'Brot',
				'Bananen',
				'Tomaten',
				'Käse',
				'Joghurt',
				'Kaffee',
				'Spülmittel',
				'Zahnpasta',
				'Äpfel',
				'Eier',
				'Haferflocken',
				'Butter'
			],
			details: [
				{ name: 'Milch', quantity: '2 l' },
				{ name: 'Käse', quantity: '200 g', note: 'mittelalt, von der Theke' },
				{ name: 'Bananen', note: 'nicht zu reif' },
				{ name: 'Eier', quantity: '10' },
				{ name: 'Tomaten', quantity: '6' },
				{ name: 'Joghurt', quantity: '4', note: 'natur' }
			],
			checked: ['Brot', 'Kaffee', 'Äpfel'],
			open: 'Käse'
		},
		others: [
			{ name: 'Drogerie', items: ['Pflaster', 'Shampoo', 'Sonnencreme'] },
			{ name: 'Grillen am Samstag', items: ['Würstchen', 'Grillkohle', 'Kartoffelsalat', 'Bier'] }
		],
		typing: '2 Sa',
		pasted:
			'Hamburg\n\n[Obst - Gemüse - Nüsse]\nMango\nPaprika, rot\n1 kg Kartoffeln\n\n[Backwaren]\nBrot\n\n[Kühltheke - Milchprodukte]\n1 l Erbsenmilch\nFeta\n\n[Müsli - Cornflakes - Cerealien]\nAhornsirup\nChiasamen\n',
		clip: {
			labels: ['Alice', 'Bob'],
			alice: { name: 'Milch', amount: '3 Liter' },
			bob: 'Kaffee',
			captions: [
				'Alice legt eine Liste an. Bob hat noch keine.',
				'Sie teilt sie per Link oder QR-Code.',
				'Bob tritt per Einladung bei, und Alice sieht ihn dazukommen.',
				'Zum Planen wechselt Alice zu „Bearbeiten“.',
				'Sie tippt „3 Liter Milch“: Milch, 3 Liter, erscheint bei Bob.',
				'Bob wechselt auch zu „Bearbeiten“ und trägt Kaffee ein.',
				'Im Laden wechseln beide zu „Einkaufen“.',
				'Alice nimmt die Milch, und bei Bob ist sie abgehakt.',
				'Bob hat kein Netz: Sein Haken wartet, oben gelb gezählt.',
				'Das Netz ist zurück: Der Haken kommt an. Alles erledigt.'
			]
		}
	}
};

const pick = <T extends string>(env: string | undefined, all: T[]): T[] =>
	env ? (env.split(/\s+/).filter((v) => (all as string[]).includes(v)) as T[]) : all;
const THEMES = pick<Theme>(process.env.SHOTS_THEMES, ['light', 'dark']);

// SHOTS_WANT narrows a run to named images, `<locale>/<theme>/<n>-<screen>`
// or `<locale>/clip` (space-separated): scripts/shots.sh readme sets it from
// the README images asked for. The story still runs whole up to the last
// wanted screen's step, since every screen stands on the steps before it, but
// only the wanted locales and themes run, only the wanted screens are shot,
// and the clip and the barcode scan run only when something needs them.
const WANT = process.env.SHOTS_WANT?.split(/\s+/).filter(Boolean);
const LOCALES = pick<Locale>(process.env.SHOTS_LOCALES, ['en', 'de']).filter(
	(l) => !WANT || WANT.some((w) => w.startsWith(`${l}/`))
);

/** Whether `<locale>/<theme>/<name>` is one of this run's images. */
function wanted(locale: Locale, theme: Theme, name: string): boolean {
	return !WANT || WANT.includes(`${locale}/${theme}/${name}`);
}

/** The themes `locale`'s screens are shot in. */
function themesFor(locale: Locale): Theme[] {
	return THEMES.filter((t) => !WANT || WANT.some((w) => w.startsWith(`${locale}/${t}/`)));
}

/** Whether any of `names` is wanted in `locale`, in any theme. */
function wantedAny(locale: Locale, names: string[]): boolean {
	return themesFor(locale).some((t) => names.some((n) => wanted(locale, t, n)));
}

async function signUp(page: Page, locale: Locale, nickname: string): Promise<void> {
	await addVirtualAuthenticator(page);
	await page.goto('/');
	await createAccount(page, locale, nickname);
	await expect(page.getByText(msg(locale, 'home_empty_title'))).toBeVisible();
}

async function addItems(page: Page, locale: Locale, items: string[]): Promise<void> {
	await page.getByTestId('view-toggle-list').click();
	const input = page.getByRole('combobox', { name: msg(locale, 'add_label') });
	const rows = page.locator('[data-testid="row"]');
	const before = await rows.count();
	// Enter would take the highlighted suggestion, which is a completion
	// ("Tomaten" → "Tomatenmark"), so each name is picked explicitly: the
	// dictionary's own entry when it has this exact name, else "Add …". One
	// locator for both, re-resolved on every retry: "Add …" leaves the
	// dropdown when the exact entry arrives ([D-305]), and a click aimed at it
	// once it had shown first waited for a row that was gone.
	for (const [i, name] of items.entries()) {
		await input.fill(name);
		await page.locator(`[data-ta-name="${name}"], [data-ta-add]`).first().click();
		await expect(rows).toHaveCount(before + i + 1);
	}
}

/** Waits until the dictionary mirror has arrived: without it, every item
 *  would land in the "Others" aisle and the shop view would show no aisles. */
async function waitForDictionary(page: Page, locale: Locale): Promise<void> {
	await page.getByTestId('view-toggle-list').click();
	const input = page.getByRole('combobox', { name: msg(locale, 'add_label') });
	await input.fill('Mil');
	await expect(page.locator('[data-ta-name]').first()).toBeVisible();
	await input.fill('');
}

/** Opens an item's detail sheet from its row in the editing view. */
async function openDetail(page: Page, locale: Locale, name: string) {
	await page.locator('[data-testid="row"]', { hasText: name }).first().locator('.row-name').click();
	const sheet = page.getByRole('dialog', { name: msg(locale, 'list_detail_title') });
	await expect(sheet).toBeVisible();
	return sheet;
}

/** Sets quantities and notes in each item's detail sheet; each field commits
 *  on its own blur (tests/item-edit.spec.ts). */
async function setDetails(page: Page, locale: Locale, details: Household['main']['details']) {
	for (const { name, quantity, note } of details) {
		const sheet = await openDetail(page, locale, name);
		for (const [id, value] of [
			['#detail-quantity', quantity],
			['#detail-note', note]
		] as const) {
			if (value === undefined) continue;
			await sheet.locator(id).fill(value);
			await sheet.locator(id).blur();
		}
		await sheet.getByRole('button', { name: msg(locale, 'common_done') }).click();
		await expect(sheet).toBeHidden();
	}
}

async function openList(page: Page, name: string): Promise<void> {
	await page.goto('/');
	await page
		.getByRole('link', { name: new RegExp(name) })
		.first()
		.click();
	await expect(page).toHaveURL(/\/list\/[^/]+$/);
}

/** An active tile in the shopping view, by the item's name. */
const tile = (page: Page, name: string) =>
	page.locator('[data-testid="tile"]').filter({ hasText: new RegExp(`^\\s*${name}`) });

for (const locale of LOCALES) {
	test(`app screens (${locale})`, async ({ browser }) => {
		test.skip(themesFor(locale).length === 0, `no ${locale} screen is wanted`);
		const h = HOUSEHOLDS[locale];
		const { context, page } = await device(browser, locale, 'light');
		await installCamera(page, BARCODE);

		// The household: three lists, the first one half shopped.
		await signUp(page, locale, h.nickname);
		await createList(page, locale, h.main.name);
		await waitForDictionary(page, locale);
		await addItems(page, locale, h.main.items);
		await setDetails(page, locale, h.main.details);
		for (const list of h.others) {
			await page.goto('/');
			await createList(page, locale, list.name);
			await addItems(page, locale, list.items);
		}
		await openList(page, h.main.name);
		await page.getByTestId('view-toggle-shop').click();
		for (const name of h.main.checked) {
			await tile(page, name).click();
			await settle(page);
		}

		// A second member, so the list reads as shared: Ben joins by the link.
		await page.getByTestId('list-menu').click();
		await page.getByRole('button', { name: msg(locale, 'share_title') }).click();
		const invite = await (
			await showInviteLink(page, msg(locale, 'share_create_link'))
		)
			.locator('span')
			.innerText();
		await page.keyboard.press('Escape');
		const ben = await device(browser, locale, 'light');
		await signUp(ben.page, locale, h.partner);
		await ben.page.goto(invite);
		await ben.page.getByRole('button', { name: msg(locale, 'share_join_action') }).click();
		await expect(ben.page).toHaveURL(/\/list\/[^/]+$/);

		// The scanned product is on the list, its tile in the shop and in the
		// home's counts after the first theme, so a run that shoots any of
		// those scans too, or they would show another list than a full run.
		const later = themesFor(locale).slice(1);
		const needScan =
			wantedAny(locale, ['4-scan', '5-found', '6-list', '9-shop', '12-done']) ||
			later.some((t) => wanted(locale, t, '2-home'));

		/** The main list, in one of its two views: each step starts from here. */
		async function onList(view: 'list' | 'shop'): Promise<void> {
			await openList(page, h.main.name);
			await page.getByTestId(`view-toggle-${view}`).click();
		}

		let scanned = false;
		for (const theme of themesFor(locale)) {
			await page.emulateMedia({ colorScheme: theme });
			const at = (n: number, screen: string) => `${locale}/${theme}/${n}-${screen}`;
			const want = (n: number, screen: string) => wanted(locale, theme, `${n}-${screen}`);

			// Signed out: a separate device, so this account stays signed in.
			// No authenticator here, so the background passkey sign-in the
			// screen starts would fail and show its error; switch it off.
			if (want(1, 'signin')) {
				const visitor = await device(browser, locale, theme);
				await disableConditionalMediation(visitor.page, { acrossNavigations: true });
				await visitor.page.goto('/');
				await expect(
					visitor.page.getByRole('button', { name: msg(locale, 'auth_create_account') })
				).toBeVisible();
				await settle(visitor.page);
				await shoot(visitor.page, visitor.page, at(1, 'signin'));
				await visitor.context.close();
			}

			// A reload drops the undo toasts the check-offs left.
			if (want(2, 'home')) {
				await page.goto('/');
				await expect(page.getByRole('link', { name: new RegExp(h.main.name) })).toBeVisible();
				await settle(page);
				await shoot(page, page, at(2, 'home'));
			}

			if (want(3, 'suggest')) {
				await onList('list');
				const input = page.getByRole('combobox', { name: msg(locale, 'add_label') });
				await input.fill(h.typing);
				await expect(page.locator('[data-ta-name]').first()).toBeVisible();
				await settle(page);
				await shoot(page, page, at(3, 'suggest'));
				await input.fill('');
				await input.blur();
			}

			// The scan: the viewfinder with the label coming into view, then the
			// product the server found. A second theme scans the same code, which
			// the app answers by jumping to the row — no found card to shoot.
			if (needScan && (!scanned || want(4, 'scan'))) {
				await onList('list');
				const rows = page.locator('[data-testid="row"]');
				await expect(rows.first()).toBeVisible();
				const before = await rows.count();
				await page.getByTestId('scan-trigger').click();
				const scanner = page.getByRole('dialog', { name: msg(locale, 'scan_title') });
				await expect(scanner.locator('video')).toBeVisible();
				await page.waitForTimeout(800);
				if (want(4, 'scan')) await shoot(page, page, at(4, 'scan'));
				await aimCamera(page);
				if (!scanned) {
					// Only the found shot needs the photo on the card: the lookup waits
					// a few seconds for it and then answers without it ([D-21]).
					if (want(5, 'found')) {
						await expect(
							scanner.locator('img'),
							'the product photo: is the Open Food Facts image host slow?'
						).toBeVisible({ timeout: 30_000 });
						await shoot(page, page, at(5, 'found'));
					}
					await expect(rows).toHaveCount(before + 1);
					scanned = true;
				}
				await expect(scanner).toBeHidden({ timeout: 30_000 });
				await lowerCamera(page);
			}

			if (want(6, 'list')) {
				await onList('list');
				await expect(page.locator('[data-testid="row"]').first()).toBeVisible();
				await settle(page);
				await shoot(page, page, at(6, 'list'));
			}

			if (want(7, 'detail')) {
				await onList('list');
				const sheet = await openDetail(page, locale, h.main.open);
				await settle(page);
				await shoot(page, page, at(7, 'detail'));
				await sheet.getByRole('button', { name: msg(locale, 'common_done') }).click();
				await expect(sheet).toBeHidden();
			}

			if (want(8, 'share')) {
				await onList('list');
				await page.getByTestId('list-menu').click();
				await page.getByRole('button', { name: msg(locale, 'share_title') }).click();
				await expect(page.getByTestId('invite-link')).toBeVisible();
				await page.getByRole('dialog').getByText(msg(locale, 'share_qr'), { exact: true }).click();
				await settle(page);
				await shoot(page, page, at(8, 'share'));
				await page.keyboard.press('Escape');
			}

			if (want(9, 'shop')) {
				await onList('shop');
				await expect(page.locator('[data-testid="tile"]').first()).toBeVisible();
				await settle(page);
				await shoot(page, page, at(9, 'shop'));
			}

			// Moving over from another app: the pasted list, then its review.
			// Nothing is confirmed, so the household's lists stay as they are
			// for the next theme's shots.
			if (want(10, 'import') || want(11, 'review')) {
				await page.goto('/');
				await page.getByRole('button', { name: msg(locale, 'home_import_list') }).click();
				const paste = page.getByLabel(msg(locale, 'import_paste_label'));
				await paste.fill(h.pasted);
				await paste.blur();
				// Its start, the list's name and first section, is what says where it came from.
				await paste.evaluate((el) => (el.scrollTop = 0));
				await settle(page);
				if (want(10, 'import')) await shoot(page, page, at(10, 'import'));
				if (want(11, 'review')) {
					await page.getByRole('button', { name: msg(locale, 'import_next') }).click();
					await expect(page.locator('[data-import-row]').first()).toBeVisible();
					await settle(page);
					await shoot(page, page, at(11, 'review'));
				}
			}

			// Not in the README: the screens a design change elsewhere touches
			// that the story above never reaches.
			if (want(12, 'done')) {
				await onList('shop');
				// The bought items under the last aisles still open, from an
				// aisle's top, so no tile shows cut under its sticky header.
				await page.getByTestId('done-head').evaluate((head) => {
					const end = head.closest('section')!.getBoundingClientRect().bottom + scrollY;
					const tops = [...document.querySelectorAll('section.aisle')].map(
						(s) => s.getBoundingClientRect().top + scrollY
					);
					const top = tops.find((t) => t + innerHeight >= end);
					scrollTo(0, top ?? end - innerHeight);
				});
				await settle(page);
				await shoot(page, page, at(12, 'done'));
			}

			if (want(13, 'settings')) {
				await page.goto('/settings');
				await expect(
					page.getByRole('heading', { level: 1, name: msg(locale, 'settings_title') })
				).toBeVisible();
				await settle(page);
				await shoot(page, page, at(13, 'settings'));
			}

			if (want(14, 'menu')) {
				await onList('list');
				await page.getByTestId('list-menu').click();
				await expect(page.getByRole('dialog')).toBeVisible();
				await settle(page);
				await shoot(page, page, at(14, 'menu'));
				await page.keyboard.press('Escape');
			}

			if (want(15, 'categories')) {
				await onList('list');
				await page.getByTestId('list-menu').click();
				await page.getByRole('button', { name: msg(locale, 'categories_edit') }).click();
				await expect(page).toHaveURL(/\/categories/);
				await settle(page);
				await shoot(page, page, at(15, 'categories'));
			}

			if (want(16, 'previous')) {
				await onList('list');
				await page.getByRole('button', { name: msg(locale, 'history_previous_items') }).click();
				await expect(page).toHaveURL(/\/previous/);
				await settle(page);
				await shoot(page, page, at(16, 'previous'));
			}
		}

		await ben.context.close();
		await context.close();
	});
}

for (const locale of LOCALES) {
	test(`clip (${locale})`, async ({ browser }) => {
		test.skip(!!WANT && !WANT.includes(`${locale}/clip`), `the ${locale} clip is not wanted`);
		const h = HOUSEHOLDS[locale];
		const { labels, alice: alices, bob: bobs, captions } = h.clip;
		const alice = await device(browser, locale, 'light');
		const bob = await device(browser, locale, 'light');

		// Off camera: Alice has an empty list open in the shopping view, the
		// app's default, and Bob is signed in with no lists at all. The two
		// views are the app's own idea, so every switch between them is on
		// camera.
		await signUp(alice.page, locale, labels[0]);
		await createList(alice.page, locale, h.main.name);
		await waitForDictionary(alice.page, locale);
		await alice.page.getByTestId('view-toggle-shop').click();
		await expect(alice.page.getByText(msg(locale, 'list_empty_title'))).toBeVisible();
		await signUp(bob.page, locale, labels[1]);
		await settle(alice.page);

		const { page } = alice;
		const input = (p: Page) => p.getByRole('combobox', { name: msg(locale, 'add_label') });
		const row = (p: Page, name: string) =>
			p.locator('[data-testid="row"]').filter({ hasText: new RegExp(`^\\s*${name}`) });
		const done = (p: Page, name: string) =>
			p.getByTestId('done-row').filter({ hasText: new RegExp(`^\\s*${name}`) });
		const chipOf = (p: Page) => p.getByRole('status', { name: msg(locale, 'banner_label') });
		const hold = (ms: number) => page.waitForTimeout(ms);
		// Every screen stays up at least READ once it has appeared, so its
		// caption and its content can both be read; AIM is the beat before a
		// tap, so the eye finds the finger first. TYPE is per letter.
		const READ = 2500;
		const AIM = 700;
		const TYPE = 480;
		// The beat between focusing the add field and the first letter.
		const FOCUS = 1000;

		const rec = await record([page, bob.page], async ({ caption, tap, mark }) => {
			caption(captions[0]);
			await hold(READ);

			caption(captions[1], 0);
			await hold(AIM);
			await tap(0, page.getByTestId('list-menu'));
			await hold(READ);
			await tap(0, page.getByRole('button', { name: msg(locale, 'share_title') }));
			const sheet = page.getByRole('dialog');
			// A new list has no link until one is created ([D-330]).
			await hold(READ);
			await tap(0, sheet.getByRole('button', { name: msg(locale, 'share_create_link') }));
			await expect(page.getByTestId('invite-link')).toBeVisible();
			const invite = await page.locator('[data-testid="invite-link"] span').innerText();
			await hold(READ);
			await tap(0, sheet.getByText(msg(locale, 'share_qr'), { exact: true }));
			await hold(READ);

			// Bob's camera app would read the code; the clip cuts to the link.
			caption(captions[2], 1);
			await bob.page.goto(invite);
			const join = bob.page.getByRole('button', { name: msg(locale, 'share_join_action') });
			await expect(join).toBeVisible();
			await hold(READ);
			await tap(1, join);
			await expect(bob.page).toHaveURL(/\/list\/[^/]+$/);
			// The open sheet re-reads its roster every few seconds ([D-236]).
			const arrived = sheet.locator('.roster > *').filter({ hasText: labels[1] });
			await expect(arrived).toBeVisible({ timeout: 10_000 });
			await mark(0, arrived);
			await hold(READ);
			await tap(0, sheet.getByRole('button', { name: msg(locale, 'common_close') }));
			await expect(sheet).toBeHidden();
			await hold(READ);

			caption(captions[3], 0);
			await hold(AIM);
			await tap(0, page.getByTestId('view-toggle-list'));
			await expect(input(page)).toBeVisible();
			await mark(0, page.getByTestId('view-toggle'));
			await hold(READ);

			caption(captions[4], 0);
			await hold(AIM);
			await tap(0, input(page));
			await hold(FOCUS);
			await input(page).pressSequentially(`${alices.amount} ${alices.name}`, { delay: TYPE });
			const pickA = page.locator(`[data-ta-name="${alices.name}"]`).first();
			await expect(pickA).toBeVisible();
			await hold(READ);
			await tap(0, pickA);
			await input(page).blur();
			await expect(tile(bob.page, alices.name)).toContainText(alices.amount);
			await mark(1, tile(bob.page, alices.name));
			await hold(READ);

			caption(captions[5], 1);
			await hold(AIM);
			await tap(1, bob.page.getByTestId('view-toggle-list'));
			await expect(input(bob.page)).toBeVisible();
			await mark(1, bob.page.getByTestId('view-toggle'));
			await hold(READ);
			await tap(1, input(bob.page));
			await hold(FOCUS);
			await input(bob.page).pressSequentially(bobs, { delay: TYPE });
			const pickB = bob.page.locator(`[data-ta-name="${bobs}"]`).first();
			await expect(pickB).toBeVisible();
			await hold(READ);
			await tap(1, pickB);
			await input(bob.page).blur();
			await expect(row(page, bobs)).toBeVisible();
			await mark(0, row(page, bobs));
			await hold(READ);

			caption(captions[6]);
			await hold(AIM);
			await tap(0, page.getByTestId('view-toggle-shop'));
			await hold(AIM);
			await tap(1, bob.page.getByTestId('view-toggle-shop'));
			await mark(0, page.getByTestId('view-toggle'));
			await mark(1, bob.page.getByTestId('view-toggle'));
			await hold(READ);

			caption(captions[7], 0);
			await hold(AIM);
			await tap(0, tile(page, alices.name));
			await expect(done(bob.page, alices.name)).toBeVisible();
			await mark(1, done(bob.page, alices.name));
			await hold(READ);

			// A dead spot: Bob's phone still reports a connection, but nothing
			// reaches the server, so his tick waits in the outbox and the sync
			// chip turns amber with the count (offline would be the grey cloud-off).
			// When the block lifts, the app's own 5s retry ([D-164]) sends it.
			caption(captions[8], 1);
			await bob.context.route('**/api/**', (route) => route.abort('internetdisconnected'));
			await hold(AIM);
			await tap(1, tile(bob.page, bobs));
			const chip = chipOf(bob.page);
			await expect(chip.locator('.banner.pending')).toBeVisible();
			await mark(1, chip);
			await hold(READ);
			await expect(tile(page, bobs)).toBeVisible();
			await hold(READ);

			caption(captions[9]);
			await bob.context.unroute('**/api/**');
			await expect(done(page, bobs)).toBeVisible({ timeout: 15_000 });
			await mark(0, done(page, bobs));
			await expect(chip.locator('.banner.synced')).toBeVisible();
			await mark(1, chip);
			await hold(READ);
		});
		await compose(browser, rec, { name: `${locale}/clip`, labels });

		await bob.context.close();
		await alice.context.close();
	});
}
