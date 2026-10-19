// The add box (§9 / §9.1): typeahead ranking and the dedup "already on the
// list" jump. Also covers auto-categorisation, checked-item reactivation, and
// both suppression paths (§6.11).
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The add box renders the real ScanButton, so reaching its scan-dedup handoff
// means stubbing the camera + WASM decode the same way ScanButton's own test
// does — happy-dom has neither.
// The dedup jump's only feedback is its toast, so the suite has to see the
// calls: ListView's reveal is a no-op here (no rows rendered) and there is no
// banner any more.
// A pasted list goes to the import review ([D-271]): goto is spied on over
// the test kit's fake history.
vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});
vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({}, { show: true })
);

vi.mock('#lib/scan/decode.js', async () => {
	const actual = await vi.importActual<typeof import('#lib/scan/decode.js')>('#lib/scan/decode.js');
	return {
		...actual,
		isCameraScanSupported: vi.fn(() => true),
		startCameraScan: vi.fn(() => ({ result: Promise.resolve(''), stop: vi.fn() }))
	};
});

// `Now` (#lib/state/clock) ticks on a REAL timer scheduled at the next
// midnight — up to a day away inside a test. Swap it for one a test can move,
// so midnight can be delivered deterministically; every other test keeps the
// construction-time Date.now() and is unaffected.
const clock = vi.hoisted(() => ({ instances: [] as { value: number }[] }));
vi.mock('#lib/state/clock.svelte.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/state/clock.svelte.js')>();
	class Now {
		value = $state(Date.now());
		constructor() {
			clock.instances.push(this);
		}
	}
	return { ...actual, Now };
});

import { db, type Item, type ItemDictionary } from '#lib/db.js';
import { startCameraScan } from '#lib/scan/decode.js';
import {
	makeCategory,
	makeItem,
	makeTemplate,
	resetDb,
	seedList,
	putSynced
} from '#lib/test-kit/db.js';
import { nextMidnight } from '#lib/time.js';
import { loadSuppressed, suppressName } from '#lib/state/suppression.js';
import { t } from '#lib/i18n/index.js';
import { showToast } from '#lib/toasts.js';
import { goto } from '$app/navigation';
import { importHandoff } from '#lib/import-handoff.js';
import AddBar from './AddBar.svelte';

function yesterdayNoon(): string {
	const at = new Date();
	at.setDate(at.getDate() - 1);
	at.setHours(12, 0, 0, 0);
	return at.toISOString();
}

const LIST_ID = 'list-1';

function dict(overrides: Partial<ItemDictionary> & { id: string }): ItemDictionary {
	return {
		names_i18n: { de: ['Gurke'], en: ['Cucumber'] },
		default_category: null,
		popularity: 1,
		...overrides
	};
}

async function renderBar(onjump = vi.fn()) {
	render(AddBar, { listId: LIST_ID, onjump });
	// `combobox`, not `textbox`: the input owns the typeahead through the ARIA
	// combobox pattern, so that is the role it exposes.
	const input = await screen.findByRole('combobox', { name: t('add_label') });
	return { input, onjump };
}

// bits-ui's combobox opens on a character keydown (not on the input event
// alone), so a realistic keystroke is keydown + input together. Tests that only
// need to READ suggestions open with a single keydown, then set the value.
async function openAndType(input: HTMLElement, value: string): Promise<void> {
	await fireEvent.keyDown(input, { key: 'x' });
	await fireEvent.input(input, { target: { value } });
}

// The Enter contract the user asked for: Enter accepts the top match. bits-ui
// applies the first-candidate highlight when the options mount (after a tick),
// and re-applies it on EVERY input event — so settleHighlight (a final no-op
// input, mirroring the next real keystroke) deterministically re-highlights the
// first candidate against the fully-rendered set, whichever row happened to
// mount first during store hydration.
async function settleHighlight(input: HTMLElement): Promise<void> {
	await fireEvent.input(input, { target: { value: (input as HTMLInputElement).value } });
	await waitFor(() => expect(document.querySelector('[data-highlighted]')).not.toBeNull());
}

async function enterSelectsTop(input: HTMLElement): Promise<void> {
	await settleHighlight(input);
	await fireEvent.keyDown(input, { key: 'Enter' });
}

beforeEach(async () => {
	await resetDb();
});

describe('AddBar — typeahead ranking (§9)', () => {
	it('unions dictionary + per-list picks on a prefix match and excludes suppressed names', async () => {
		await seedList({
			listId: LIST_ID,
			categories: [makeCategory({ id: 'cat-produce', list: LIST_ID, slug: 'produce', name: null })],
			templates: [makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst', en: 'Produce' } })],
			items: [makeItem({ list: LIST_ID, name: 'Gurkensalat' })]
		});
		await db.item_dictionary.bulkPut([
			dict({
				id: 'item_gurke',
				names_i18n: { de: ['Gurke'], en: ['Cucumber'] },
				default_category: 'produce',
				popularity: 5
			}),
			dict({
				id: 'item_gurkenwasser',
				names_i18n: { de: ['Gurkenwasser'], en: ['Cucumber water'] },
				popularity: 1
			})
		]);
		await suppressName('Gurkenwasser');

		const { input } = await renderBar();
		await openAndType(input, 'Gur');

		await waitFor(() => {
			const names = Array.from(document.querySelectorAll('[data-ta-name]')).map((el) =>
				el.getAttribute('data-ta-name')
			);
			expect(names).toContain('Gurke');
			expect(names).toContain('Gurkensalat');
			expect(names).not.toContain('Gurkenwasser');
		});
	});
});

describe('AddBar — synonym hits', () => {
	const sahne = () =>
		dict({
			id: 'item_cream',
			names_i18n: { de: ['Sahne', 'Rahm'], en: ['cream'] },
			default_category: 'dairy_eggs'
		});

	it("still offers this list's own row when the query matches only a synonym", async () => {
		const bought = makeItem({
			list: LIST_ID,
			name: 'Sahne',
			checked: true,
			checked_at: new Date().toISOString(),
			last_bought_at: new Date().toISOString()
		});
		await seedList({ listId: LIST_ID, items: [bought] });
		await db.item_dictionary.bulkPut([sahne()]);

		const { input } = await renderBar();
		await openAndType(input, 'Rahm');
		await waitFor(() => expect(document.querySelector('[data-ta-name="Sahne"]')).not.toBeNull());

		// …and taking it re-activates that row rather than adding a second one.
		await enterSelectsTop(input);
		await waitFor(async () =>
			expect(((await db.items.get(bought.id)) as Item).checked).toBe(false)
		);
		expect(await db.items.where('list').equals(LIST_ID).count()).toBe(1);
	});

	it('bolds only the part of the displayed name the query actually matched', async () => {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.bulkPut([
			sahne(),
			dict({ id: 'item_salt', names_i18n: { de: ['Salz'], en: ['salt'] } })
		]);

		const { input } = await renderBar();
		const bold = (name: string) =>
			document.querySelector(`[data-ta-name="${name}"] .match`)?.textContent;

		await openAndType(input, 'Rahm');
		await waitFor(() => expect(document.querySelector('[data-ta-name="Sahne"]')).not.toBeNull());
		expect(bold('Sahne')).toBe('');

		await openAndType(input, 'sa');
		await waitFor(() => expect(document.querySelector('[data-ta-name="Salz"]')).not.toBeNull());
		expect(bold('Sahne')).toBe('Sa');
		expect(bold('Salz')).toBe('Sa');
	});
});

describe('AddBar — a pick carries its purchase date ([D-18])', () => {
	it("dates this list's own rows on the aisle line, and leaves dictionary hits bare", async () => {
		// The dropdown is the BEFORE-the-decision surface, which is why the date
		// lives here rather than in a toast after the add. Only a per-list pick can
		// carry one: a dictionary hit is a word with no row, so it has no purchase.
		await seedList({
			listId: LIST_ID,
			categories: [makeCategory({ id: 'cat-dairy', list: LIST_ID, slug: 'dairy', name: null })],
			templates: [makeTemplate({ slug: 'dairy', name_i18n: { de: 'Molkerei', en: 'Dairy' } })],
			items: [
				makeItem({
					list: LIST_ID,
					name: 'Milchreis',
					category_key: 'cat-dairy',
					checked: true,
					// Yesterday at local noon ⇒ one calendar day ago, whatever hour
					// the suite runs at.
					checked_at: yesterdayNoon(),
					last_bought_at: yesterdayNoon()
				})
			]
		});
		await db.item_dictionary.bulkPut([
			dict({
				id: 'item_milch',
				names_i18n: { de: ['Milch'], en: ['Milk'] },
				default_category: 'dairy',
				popularity: 9
			})
		]);

		const { input } = await renderBar();
		await openAndType(input, 'Milch');

		// Wait on the RESOLVED aisle, not merely on the row: the option renders
		// before the list_categories liveQuery hydrates, and asserting early reads
		// an empty category (the same race the auto-categorisation test below
		// documents). Aisle first, then the date — the aisle still identifies the
		// row, so the date joins it rather than replacing it.
		await waitFor(() =>
			expect(document.querySelector('[data-ta-name="Milchreis"] .ta-cat')?.textContent).toBe(
				'Molkerei · gestern'
			)
		);
		// Same aisle, deliberately: the ONLY difference between the two rows is the
		// date, so this cannot pass by the dictionary hit merely rendering nothing.
		expect(document.querySelector('[data-ta-name="Milch"] .ta-cat')?.textContent).toBe('Molkerei');
	});
});

describe('AddBar — the pick date follows the clock ([D-18])', () => {
	it('re-derives an open dropdown’s date wording at midnight', async () => {
		await seedList({
			listId: LIST_ID,
			categories: [makeCategory({ id: 'cat-dairy', list: LIST_ID, slug: 'dairy', name: null })],
			templates: [makeTemplate({ slug: 'dairy', name_i18n: { de: 'Molkerei', en: 'Dairy' } })],
			items: [
				makeItem({
					list: LIST_ID,
					name: 'Milchreis',
					category_key: 'cat-dairy',
					checked: true,
					// One minute before the NEXT midnight: "heute" while the
					// dropdown is open, "gestern" the moment midnight passes —
					// deterministic whatever hour the suite runs at.
					checked_at: new Date(nextMidnight() - 60_000).toISOString(),
					last_bought_at: new Date(nextMidnight() - 60_000).toISOString()
				})
			]
		});

		const { input } = await renderBar();
		await openAndType(input, 'Milch');

		// Before midnight the stamp is today's — and a stamp slightly in the
		// future reads "heute", never "morgen" (the daysAgo clamp).
		await waitFor(() =>
			expect(document.querySelector('[data-ta-name="Milchreis"] .ta-cat')?.textContent).toBe(
				'Molkerei · heute'
			)
		);

		// Midnight passes (what the real clock delivers): the OPEN dropdown must
		// re-derive — no keystroke rebuilds it — so it reads `now`, not
		// Date.now().
		for (const now of clock.instances) now.value = nextMidnight() + 60_000;
		await waitFor(() =>
			expect(document.querySelector('[data-ta-name="Milchreis"] .ta-cat')?.textContent).toBe(
				'Molkerei · gestern'
			)
		);
	});
});

describe('AddBar — auto-categorisation on a dictionary hit', () => {
	it('creates the item with the category_key matching the dictionary default_category slug', async () => {
		await seedList({
			listId: LIST_ID,
			categories: [makeCategory({ id: 'cat-produce', list: LIST_ID, slug: 'produce', name: null })],
			templates: [makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst', en: 'Produce' } })]
		});
		await db.item_dictionary.put(
			dict({
				id: 'item_gurke',
				names_i18n: { de: ['Gurke'], en: ['Cucumber'] },
				default_category: 'produce',
				popularity: 5
			})
		);

		const { input } = await renderBar();
		await openAndType(input, 'Gur');

		// Wait for the suggestion's category chip to resolve (i.e. the
		// list_categories liveQuery has hydrated), not just for the row to exist —
		// otherwise a click can race resolveCategoryKey() against an empty
		// `categories` store and silently resolve to null.
		const option = await waitFor(() => {
			const cat = document.querySelector('[data-ta-name="Gurke"] .ta-cat');
			expect(cat?.textContent).toBe('Obst');
			// The option row IS the bits-ui Combobox.Item (data-ta-name lives on
			// it), so this must not be a descendant selector.
			return document.querySelector('[data-ta-name="Gurke"]') as HTMLElement;
		});
		// bits-ui selects on pointerup, not click — happy-dom's fireEvent.click would
		// miss the handler.
		await fireEvent.pointerUp(option);

		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			const created = rows.find((r) => r.name === 'Gurke');
			expect(created).toBeDefined();
			expect(created?.category_key).toBe('cat-produce');
		});
	});
});

describe('AddBar — head-noun classification of a typed name (§9)', () => {
	/**
	 * A list with two aisles and a dictionary that knows "Schokolade" and
	 * "Milch". The chip on a rendered suggestion is the signal that BOTH liveQuery
	 * stores have hydrated — submitting before that races `categories` and
	 * silently resolves to null (the same trap the auto-categorisation test above
	 * documents).
	 */
	async function seedSweetsAndDairy(): Promise<void> {
		await seedList({
			listId: LIST_ID,
			categories: [
				makeCategory({ id: 'cat-sweets', list: LIST_ID, slug: 'snacks_sweets', name: null }),
				makeCategory({ id: 'cat-dairy', list: LIST_ID, slug: 'dairy_eggs', name: null }),
				makeCategory({ id: 'cat-other', list: LIST_ID, slug: 'other', name: null })
			],
			templates: [
				makeTemplate({ slug: 'snacks_sweets', name_i18n: { de: 'Süßes', en: 'Sweets' } }),
				makeTemplate({ slug: 'dairy_eggs', name_i18n: { de: 'Molkerei', en: 'Dairy' } }),
				makeTemplate({ slug: 'other', name_i18n: { de: 'Sonstiges', en: 'Other' } })
			]
		});
		await db.item_dictionary.bulkPut([
			dict({
				id: 'item_chocolate',
				names_i18n: { de: ['Schokolade'], en: ['Chocolate'] },
				default_category: 'snacks_sweets',
				popularity: 3
			}),
			dict({
				id: 'item_milk',
				names_i18n: { de: ['Milch'], en: ['Milk'] },
				default_category: 'dairy_eggs',
				popularity: 5
			})
		]);
	}

	async function chipFor(name: string): Promise<void> {
		await waitFor(() => {
			expect(document.querySelector(`[data-ta-name="${name}"] .ta-cat`)?.textContent).toBeTruthy();
		});
	}

	async function created(name: string): Promise<Item> {
		return await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			const row = rows.find((r) => r.name === name);
			expect(row).toBeDefined();
			return row as Item;
		});
	}

	it('files a novel compound under its head noun rather than Others', async () => {
		await seedSweetsAndDairy();
		const { input } = await renderBar();

		// Type a prefix first purely to wait out hydration, then the real name.
		await openAndType(input, 'Schok');
		await chipFor('Schokolade');
		await fireEvent.input(input, { target: { value: 'Vollmilchschokolade' } });
		await waitFor(() =>
			expect(document.querySelector('[data-ta-add="Vollmilchschokolade"]')).not.toBeNull()
		);
		await enterSelectsTop(input);

		// Not cat-dairy: "Milch" is a PREFIX here, and the head noun wins.
		expect((await created('Vollmilchschokolade')).category_key).toBe('cat-sweets');
	});

	it('Enter takes the top match, so a known name keeps its dictionary aisle', async () => {
		// Under the full combobox, Enter accepts the auto-highlighted top match —
		// here the "Milch" dictionary hit — whose default_category (dairy) beats
		// the classifier's guess.
		await seedSweetsAndDairy();
		const { input } = await renderBar();

		await openAndType(input, 'Milch');
		await chipFor('Milch');
		await enterSelectsTop(input);

		expect((await created('Milch')).category_key).toBe('cat-dairy');
	});

	// With the suggestions closed none is in sight, so Enter adds what is typed.
	it('adds the typed text on Enter once Escape has closed the suggestions', async () => {
		await seedSweetsAndDairy();
		const { input } = await renderBar();

		await openAndType(input, 'Mil');
		await chipFor('Milch');
		await fireEvent.keyDown(input, { key: 'Escape' });
		await waitFor(() => expect(document.querySelector('[data-ta-name="Milch"]')).toBeNull());
		await fireEvent.keyDown(input, { key: 'Enter' });

		await created('Mil');
		expect((await db.items.toArray()).some((r) => r.name === 'Milch')).toBe(false);
	});

	it('lets an explicitly selected suggestion keep its own aisle', async () => {
		// The dictionary deliberately files Kokosmilch away from dairy; picking it
		// must not be second-guessed by the "milch" head.
		await seedSweetsAndDairy();
		await db.item_dictionary.put(
			dict({
				id: 'item_coconut_milk',
				names_i18n: { de: ['Kokosmilch'], en: ['Coconut milk'] },
				default_category: 'snacks_sweets',
				popularity: 2
			})
		);
		const { input } = await renderBar();

		await openAndType(input, 'Kokos');
		await chipFor('Kokosmilch');
		await fireEvent.pointerUp(document.querySelector('[data-ta-name="Kokosmilch"]') as HTMLElement);

		expect((await created('Kokosmilch')).category_key).toBe('cat-sweets');
	});

	it('learns from an aisle the household itself assigned', async () => {
		await seedSweetsAndDairy();
		await putSynced([makeItem({ list: LIST_ID, name: 'Nudelsauce', category_key: 'cat-sweets' })]);
		const { input } = await renderBar();

		await openAndType(input, 'Nudel');
		await chipFor('Nudelsauce');
		await fireEvent.input(input, { target: { value: 'Bio-Nudelsauce' } });
		await waitFor(() =>
			expect(document.querySelector('[data-ta-add="Bio-Nudelsauce"]')).not.toBeNull()
		);
		await enterSelectsTop(input);

		expect((await created('Bio-Nudelsauce')).category_key).toBe('cat-sweets');
	});

	it('still leaves an unclassifiable name to Others', async () => {
		await seedSweetsAndDairy();
		const { input } = await renderBar();

		await openAndType(input, 'Schok');
		await chipFor('Schokolade');
		await fireEvent.input(input, { target: { value: 'Klebeband' } });
		await waitFor(() => expect(document.querySelector('[data-ta-add="Klebeband"]')).not.toBeNull());
		await enterSelectsTop(input);

		expect((await created('Klebeband')).category_key).toBeNull();
	});

	it('draws the as-typed row as a suggestion, with the guessed aisle [D-332]', async () => {
		await seedSweetsAndDairy();
		const { input } = await renderBar();

		// "Vollmilchschokolade" is novel — no suggestion — so the as-typed row is
		// the only candidate, and its preview shows the head-noun guess the item
		// will actually land in (the same classify() call commitAdd makes).
		await openAndType(input, 'Vollmilchschokolade');
		const addRow = await waitFor(() => {
			const el = document.querySelector('[data-ta-add="Vollmilchschokolade"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		// Wait for the corpus to hydrate (same signal as chipFor) so the preview
		// shows the real guess, not a pre-hydration Others fallback.
		await waitFor(() => expect(addRow.querySelector('.ta-cat')?.textContent).toBe('Süßes'));
		// The text as typed, under the aisle's plate in OpenMoji ([D-181]),
		// as a suggestion's row reads: no "Add" wording of its own.
		expect(addRow.querySelector('.ta-name')?.textContent).toBe('Vollmilchschokolade');
		expect(addRow.querySelector('img')?.getAttribute('src')).toBeTruthy();
	});
});

describe('AddBar — dedup "already on the list" jump (§9.1)', () => {
	it('does not create a duplicate for an ACTIVE match; jumps via onjump instead', async () => {
		const existing = makeItem({ list: LIST_ID, name: 'Milch', checked: false });
		await seedList({ listId: LIST_ID, items: [existing] });

		const { input, onjump } = await renderBar();
		await openAndType(input, 'Milch');
		// Wait for the liveQuery-backed items store to hydrate before submitting,
		// or Enter races an empty local view and the dedup check trivially finds
		// nothing. The suggestion for the existing row is the hydration proof.
		await waitFor(() => expect(document.querySelector('[data-ta-name="Milch"]')).not.toBeNull());
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(() => {
			expect(onjump).toHaveBeenCalledWith(existing.id);
		});

		const rows = await db.items.where('list').equals(LIST_ID).toArray();
		expect(rows.length).toBe(1);
	});

	it('toasts the jump — the reveal alone is invisible when the row is on screen', async () => {
		const existing = makeItem({ list: LIST_ID, name: 'Milch', checked: false });
		await seedList({ listId: LIST_ID, items: [existing] });

		const { input } = await renderBar();
		await openAndType(input, 'Milch');
		await waitFor(() => expect(document.querySelector('[data-ta-name="Milch"]')).not.toBeNull());
		vi.mocked(showToast).mockClear();
		await fireEvent.keyDown(input, { key: 'Enter' });

		// No undo argument: the jump mutates nothing, so there is nothing to
		// reverse — unlike the checked branch, which reactivate() toasts with one.
		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(t('add_dedup_active', { name: 'Milch' }))
		);
	});

	it('offers undo on a fresh create, matching the reactivate branch it shares wording with', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Klebeband');

		const addRow = await waitFor(() => {
			const el = document.querySelector('[data-ta-add="Klebeband"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		vi.mocked(showToast).mockClear();
		await fireEvent.pointerUp(addRow);

		// Both branches of commitAdd say "added" now, so both have to behave the
		// same when the toast is tapped — an undo on one and not the other is the
		// kind of difference a user only discovers by losing the row.
		const undo = await waitFor(() => {
			const call = vi.mocked(showToast).mock.calls.at(-1);
			expect(call?.[0]).toBe(t('add_added', { name: 'Klebeband' }));
			expect(call?.[1]).toBeTypeOf('function');
			return call![1] as () => Promise<void>;
		});

		await undo();
		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.filter((r) => r.name === 'Klebeband' && r.deleted_at === null)).toEqual([]);
		});
	});

	it('re-activates a CHECKED match instead of creating a duplicate', async () => {
		const existing = makeItem({
			list: LIST_ID,
			name: 'Eier',
			checked: true,
			checked_at: new Date().toISOString(),
			last_bought_at: new Date().toISOString()
		});
		await seedList({ listId: LIST_ID, items: [existing] });

		const { input, onjump } = await renderBar();
		await openAndType(input, 'Eier');
		await waitFor(() => expect(document.querySelector('[data-ta-name="Eier"]')).not.toBeNull());
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(async () => {
			const stored = (await db.items.get(existing.id)) as Item;
			expect(stored.checked).toBe(false);
			expect(stored.last_bought_at).toBe(existing.last_bought_at);
		});

		const rows = await db.items.where('list').equals(LIST_ID).toArray();
		expect(rows.length).toBe(1);
		expect(onjump).not.toHaveBeenCalled();
	});
});

// [D-285] "2 l Milch" or "Milch 2 l": the amount is the quantity, shown on
// every candidate before the pick.
describe('AddBar — an amount typed with the name', () => {
	const milch = () =>
		dict({ id: 'd-milch', names_i18n: { de: ['Milch'], en: ['Milk'] }, popularity: 9 });

	it('ranks on the name, shows the amount on each candidate, and adds it as the quantity', async () => {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.put(milch());
		const { input } = await renderBar();
		await openAndType(input, '2 l Mil');

		const pick = await waitFor(() => {
			const el = document.querySelector('[data-ta-name="Milch"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		expect(pick.querySelector('.ta-qty')?.textContent).toBe('2 l');
		const addRow = document.querySelector('[data-ta-add="Mil"]') as HTMLElement;
		expect(addRow.querySelector('.ta-qty')?.textContent).toBe('2 l');

		await enterSelectsTop(input);
		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.map((r) => [r.name, r.quantity])).toEqual([['Milch', '2 l']]);
		});
	});

	it('reads an amount typed after the name too', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Klebeband 3');

		const addRow = await waitFor(() => {
			const el = document.querySelector('[data-ta-add="Klebeband"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		await fireEvent.pointerUp(addRow);
		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.map((r) => [r.name, r.quantity])).toEqual([['Klebeband', '3']]);
		});
	});

	it('keeps a number that is part of a name the list has: no chip, nothing split', async () => {
		const cola = makeItem({ list: LIST_ID, name: 'Cola 0,5', checked: false });
		await seedList({ listId: LIST_ID, items: [cola] });
		const { input } = await renderBar();
		await openAndType(input, 'Cola 0,5');

		await waitFor(() => expect(document.querySelector('[data-ta-name="Cola 0,5"]')).not.toBeNull());
		expect(document.querySelector('.ta-qty')).toBeNull();
	});

	it('sets the amount on a row already on the list, and an add without one keeps it', async () => {
		const existing = makeItem({ list: LIST_ID, name: 'Milch', quantity: '1 l', checked: false });
		await seedList({ listId: LIST_ID, items: [existing] });
		const { input, onjump } = await renderBar();

		await openAndType(input, 'Milch');
		await waitFor(() => expect(document.querySelector('[data-ta-name="Milch"]')).not.toBeNull());
		await fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(onjump).toHaveBeenCalledTimes(1));
		expect(((await db.items.get(existing.id)) as Item).quantity).toBe('1 l');

		await openAndType(input, 'Milch 2 l');
		await waitFor(() =>
			expect(document.querySelector('[data-ta-name="Milch"] .ta-qty')).not.toBeNull()
		);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(async () =>
			expect(((await db.items.get(existing.id)) as Item).quantity).toBe('2 l')
		);
		expect(showToast).toHaveBeenCalledWith(
			t('add_dedup_quantity', { name: 'Milch', quantity: '2 l' }),
			expect.any(Function)
		);
		expect(await db.items.where('list').equals(LIST_ID).count()).toBe(1);
	});
});

describe('AddBar — suppression (§6.11)', () => {
	it('"nicht mehr vorschlagen" removes a suggestion from later results in the same session', async () => {
		await seedList({ listId: LIST_ID, items: [makeItem({ list: LIST_ID, name: 'Senf' })] });

		const { input } = await renderBar();
		await openAndType(input, 'Sen');

		const suppressBtn = await waitFor(() => {
			const el = document.querySelector('[data-ta-name="Senf"] .ta-suppress');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		await fireEvent.click(suppressBtn);

		await waitFor(() => {
			expect(document.querySelector('[data-ta-name="Senf"]')).toBeNull();
		});

		// Re-typing (a fresh query) in the same session must not resurrect it.
		await fireEvent.input(input, { target: { value: '' } });
		await fireEvent.input(input, { target: { value: 'Sen' } });
		await waitFor(() => {
			expect(document.querySelector('[data-ta-name="Senf"]')).toBeNull();
		});
	});

	it('raises an undo toast when suppressing a suggestion', async () => {
		await seedList({ listId: LIST_ID, items: [makeItem({ list: LIST_ID, name: 'Senf' })] });

		const { input } = await renderBar();
		await openAndType(input, 'Sen');

		const suppressBtn = await waitFor(() => {
			const el = document.querySelector('[data-ta-name="Senf"] .ta-suppress');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});

		vi.mocked(showToast).mockClear();
		await fireEvent.click(suppressBtn);

		await waitFor(() => {
			expect(showToast).toHaveBeenCalledWith(
				t('add_suppressed', { name: 'Senf' }),
				expect.any(Function)
			);
		});
	});

	it('explicitly adding a previously-suppressed name un-suppresses it', async () => {
		await seedList({ listId: LIST_ID });
		await suppressName('Senf');
		expect(await loadSuppressed()).toContain('senf');

		const { input } = await renderBar();
		await openAndType(input, 'Senf');
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.some((r) => r.name === 'Senf')).toBe(true);
		});

		expect(await loadSuppressed()).not.toContain('senf');
	});
});

// A touch device has no Enter key within thumb reach, so the as-typed add has
// to be a row — a passive hint ("Enter fügt … hinzu") was the only affordance
// for a novel name, which is exactly the case that most needs a tap target.
describe('AddBar — tap-to-add for the typed text (touch path)', () => {
	// The highlighted row wears `--primary-soft`, so a resting fill in it is
	// indistinguishable from the fill bits-ui paints on the highlighted row. The combobox auto-highlights the
	// first candidate on every keystroke, so a second row wearing that colour
	// makes two rows read as chosen while the software keyboard's Go key commits
	// only one. Assert the invariant directly: exactly one option carries a
	// resting highlight fill, and it is the one bits-ui actually highlighted.
	it('gives no row a resting highlight fill except the highlighted one', async () => {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.bulkPut([
			dict({ id: 'item_ban', names_i18n: { de: ['Banane'], en: ['Banana'] }, popularity: 9 })
		]);
		const { input } = await renderBar();
		await openAndType(input, 'Ban');

		// Wait for the dictionary-backed suggestion, not just the as-typed row:
		// the as-typed row renders from local state and is there immediately,
		// while the store behind the suggestion hydrates a tick later.
		await waitFor(() => expect(document.querySelector('[data-ta-name]')).not.toBeNull());
		const options = [...document.querySelectorAll('[role="option"]')];
		expect(options.length).toBeGreaterThan(1);

		// Variant classes (`data-highlighted:bg-primary-soft`) are conditional and do
		// not count — only a bare, always-on utility does.
		const hasRestingFill = (el: Element) =>
			el.className.split(/\s+/).some((c) => !c.includes(':') && /^bg-primary-soft$/.test(c));

		expect(options.filter(hasRestingFill)).toEqual([]);
		await waitFor(() =>
			expect(options.filter((o) => o.hasAttribute('data-highlighted'))).toHaveLength(1)
		);
	});

	it('hands the highlight to a suggestion that arrives after the keystroke', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Mil');
		await waitFor(() =>
			expect(document.querySelector('[role="option"][data-highlighted]')).not.toBeNull()
		);

		// bits-ui re-highlights only when an item mounts AND the highlighted node
		// has left the DOM, and its oninput reads candidates synchronously — from
		// the render before the keystroke. The as-typed row is always mounted, so
		// without remounting it on a candidate change this list's live query
		// emitting late (a freshly opened list, a sync push mid-typing) leaves the
		// highlight stranded on the typed text while the real match sits below it.
		await putSynced([makeItem({ list: LIST_ID, name: 'Milch', checked: false })]);
		await waitFor(() => expect(document.querySelector('[data-ta-name="Milch"]')).not.toBeNull());

		await waitFor(() =>
			expect(
				document.querySelector('[role="option"][data-highlighted]')?.getAttribute('data-value')
			).toBe('milch')
		);
	});

	it('renders a tappable add row for a novel name and adds it on click', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Klebeband');

		const addRow = await waitFor(() => {
			const el = document.querySelector('[data-ta-add="Klebeband"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		// The as-typed row is a real Combobox option now, and bits-ui selects on
		// pointerup, not click — happy-dom's fireEvent.click would miss the handler.
		await fireEvent.pointerUp(addRow);

		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.some((r) => r.name === 'Klebeband')).toBe(true);
		});
	});

	it('still offers the add row below ranked suggestions', async () => {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.put(
			dict({ id: 'item_milch', names_i18n: { de: ['Milch'], en: ['Milk'] }, popularity: 5 })
		);

		const { input } = await renderBar();
		await openAndType(input, 'Mi');
		await waitFor(() => {
			expect(document.querySelector('[data-ta-name="Milch"]')).not.toBeNull();
		});

		// The as-typed row sits below the suggestion, even with matches present.
		expect(document.querySelector('[data-ta-add="Mi"]')).not.toBeNull();
	});

	// [D-305] The suggestion that is the typed name is its one row: an add row
	// beside it read as the same item twice. It is the top match, so Enter
	// still has a candidate, and commitAdd's findByName decides jump vs create.
	it('shows an exact name once, as its suggestion, highlighted for Enter', async () => {
		await seedList({
			listId: LIST_ID,
			items: [makeItem({ list: LIST_ID, name: 'Milch', checked: false })]
		});

		const { input } = await renderBar();
		await openAndType(input, 'Milch');
		await waitFor(() =>
			expect(document.querySelector('[data-highlighted]')?.getAttribute('data-ta-name')).toBe(
				'Milch'
			)
		);
		expect(document.querySelector('[data-ta-add]')).toBeNull();
	});
});

// The combobox is bits-ui's now: it auto-highlights the first candidate on
// open/typing, owns the arrow navigation and aria-activedescendant, and Enter
// accepts the highlighted (top) match. What the app still owns is the routing
// (suggestion key → its aisle, the as-typed row → the verbatim add) — so the
// keyboard tests here assert the user-facing contract, not bits-ui internals.
// The dropdown floats over rows that are themselves doors into the detail
// sheet, so a thumb aiming at the last suggestion and landing a few pixels low
// would open an unrelated item's sheet. happy-dom cannot hit-test a layout, so
// what is pinned here is the mechanism that makes the miss harmless: while the
// dropdown is open there IS a scrim over the list, its tap closes the typeahead
// and nothing else, and the text that was typed survives it.
describe('AddBar — a tap outside dismisses instead of reaching the list ([D-131])', () => {
	it('covers the list with a scrim for exactly as long as the dropdown is open', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		expect(screen.queryByTestId('ta-scrim')).toBeNull();

		await openAndType(input, 'Milch');
		await waitFor(() => expect(screen.queryByTestId('ta-scrim')).not.toBeNull());

		await fireEvent.input(input, { target: { value: '' } });
		await waitFor(() => expect(screen.queryByTestId('ta-scrim')).toBeNull());
	});

	it('closes the dropdown on a scrim tap, keeping the typed name', async () => {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.bulkPut([
			dict({ id: 'item_milch', names_i18n: { de: ['Milch'], en: ['Milk'] }, popularity: 9 })
		]);
		const { input } = await renderBar();
		await openAndType(input, 'Mil');
		await waitFor(() => expect(document.querySelector('[data-ta-name]')).not.toBeNull());

		await fireEvent.click(screen.getByTestId('ta-scrim'));

		await waitFor(() => expect(document.querySelector('[role="option"]')).toBeNull());
		// The dismiss is not a cancel: nothing was added, and the near miss did
		// not cost the user what they had typed.
		expect((input as HTMLInputElement).value).toBe('Mil');
		expect(await db.items.where('list').equals(LIST_ID).count()).toBe(0);
	});

	it('reopens on refocus, so the dismissal costs no keystroke to undo', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Mil');
		await waitFor(() => expect(screen.queryByTestId('ta-scrim')).not.toBeNull());

		await fireEvent.click(screen.getByTestId('ta-scrim'));
		await waitFor(() => expect(screen.queryByTestId('ta-scrim')).toBeNull());

		await fireEvent.focus(input);
		await waitFor(() => expect(screen.queryByTestId('ta-scrim')).not.toBeNull());
	});

	// bits-ui's dismissible layer closes the content from a DOCUMENT pointerdown
	// (debounced 10ms). Left alone it would unmount the scrim mid-gesture and the
	// pointerUP would land on the row underneath — the exact tap this guards. The
	// scrim therefore stops pointerdown from reaching it and dismisses on click.
	it('keeps the scrim up through the press, and only dismisses on the release', async () => {
		await seedList({ listId: LIST_ID });
		const { input } = await renderBar();
		await openAndType(input, 'Mil');
		const scrim = await screen.findByTestId('ta-scrim');

		await fireEvent.pointerDown(scrim);
		await new Promise((r) => setTimeout(r, 30));
		expect(screen.queryByTestId('ta-scrim')).not.toBeNull();

		await fireEvent.click(scrim);
		await waitFor(() => expect(screen.queryByTestId('ta-scrim')).toBeNull());
	});
});

describe('AddBar — typeahead keyboard navigation', () => {
	async function seedThree() {
		await seedList({ listId: LIST_ID });
		await db.item_dictionary.bulkPut([
			dict({ id: 'item_a', names_i18n: { de: ['Sahne'], en: ['Cream'] }, popularity: 9 }),
			dict({ id: 'item_b', names_i18n: { de: ['Salz'], en: ['Salt'] }, popularity: 8 }),
			dict({ id: 'item_c', names_i18n: { de: ['Salat'], en: ['Salad'] }, popularity: 7 })
		]);
	}

	function optionNames(): (string | null)[] {
		return Array.from(document.querySelectorAll('[role="option"]'))
			.map((el) => el.getAttribute('data-ta-name'))
			.filter((n) => n !== null);
	}

	function activeName(input: HTMLElement): string | null {
		const id = input.getAttribute('aria-activedescendant');
		if (!id) return null;
		return document.getElementById(id)?.getAttribute('data-ta-name') ?? null;
	}

	it('navigates the highlight with the arrow keys, reported via aria-activedescendant', async () => {
		await seedThree();
		const { input } = await renderBar();

		await openAndType(input, 'Sa');
		await waitFor(() => expect(optionNames().length).toBeGreaterThanOrEqual(2));
		const names = optionNames();

		// Settle the first-candidate highlight (the as-typed row can win the
		// initial mount race during store hydration), then navigate.
		await settleHighlight(input);
		expect(activeName(input)).toBe(names[0]);

		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(activeName(input)).toBe(names[1]);

		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(activeName(input)).toBe(names[0]);

		// Clamped, not wrapped — ArrowUp at the top stays at the top.
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(activeName(input)).toBe(names[0]);

		await fireEvent.keyDown(input, { key: 'End' });
		// End lands on the last candidate — the as-typed row at the foot, which is
		// a real option (no data-ta-name; it carries data-ta-add).
		expect(document.querySelector('[data-highlighted]')?.getAttribute('data-ta-add')).toBe('Sa');
	});

	it('Enter accepts the top match, not the typed text', async () => {
		await seedThree();
		const { input } = await renderBar();

		await openAndType(input, 'Sa');
		await waitFor(() => expect(optionNames().length).toBeGreaterThanOrEqual(2));
		const top = optionNames()[0];

		await enterSelectsTop(input);

		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			// The top suggestion's full name, not the two characters that were typed.
			expect(rows.map((r) => r.name)).toEqual([top]);
		});
	});

	it('Enter with no matching suggestions adds the typed text verbatim', async () => {
		// "Klebeband" matches nothing in the seed: the as-typed row is the only
		// candidate, so Enter lands on it instead of closing the dropdown empty.
		await seedThree();
		const { input } = await renderBar();

		await openAndType(input, 'Klebeband');
		await waitFor(() => expect(document.querySelector('[data-ta-add="Klebeband"]')).not.toBeNull());
		await enterSelectsTop(input);

		await waitFor(async () => {
			const rows = await db.items.where('list').equals(LIST_ID).toArray();
			expect(rows.map((r) => r.name)).toEqual(['Klebeband']);
		});
	});

	it('Backspace and Delete edit the text — they never suppress a suggestion', async () => {
		await seedThree();
		const { input } = await renderBar();

		await openAndType(input, 'Sa');
		await waitFor(() => expect(optionNames().length).toBeGreaterThanOrEqual(2));
		const before = optionNames();

		// The ✕ is the only suppression affordance now; the keyboard never
		// banishes a suggestion (auto-highlight would make it fire on every
		// keystroke). Backspace/Delete are ordinary text editing.
		await fireEvent.keyDown(input, { key: 'Backspace' });
		await fireEvent.keyDown(input, { key: 'Delete' });
		expect(optionNames()).toEqual(before);
		expect(await loadSuppressed()).toEqual([]);
	});
});

// §9.2 scan-dedup at the seam between the scanner and the add box: the
// scanner reports the matched row through `onadded`, and the add box hands it
// to `onjump` — so scanning something already on the list jumps to its row,
// exactly as typing the same item's name does.
describe('AddBar — scan-dedup handoff (§9.2)', () => {
	const EAN = '3017620422003';

	async function scan(barcode: string): Promise<void> {
		vi.mocked(startCameraScan).mockReturnValue({
			result: Promise.resolve(barcode),
			stop: vi.fn()
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Barcode scannen' }));
	}

	it('jumps to the existing row when a scanned barcode is already on the list', async () => {
		const existing = makeItem({ list: LIST_ID, name: 'Nutella', barcode: EAN });
		await seedList({ listId: LIST_ID, items: [existing] });

		const { onjump } = await renderBar();
		await scan(EAN);

		await waitFor(() => expect(onjump).toHaveBeenCalledWith(existing.id));
		// And no duplicate: the scan resolved to the row that was already there.
		// (`barcode` is not an IndexedDB index — see db.ts's stores() — so filter.)
		const rows = await db.items.toArray();
		expect(rows.filter((r) => r.barcode === EAN)).toHaveLength(1);
	});
});

// [D-218] A deployment with the scanner off offers no scan button: the field
// is the band's only control. Unconfigured, the button is there.
describe('AddBar — scanner switch', () => {
	it('offers the scan button by default', async () => {
		await renderBar();
		expect(screen.getByRole('button', { name: t('scan_title') })).toBeTruthy();
	});

	it('renders no scan button with the scanner off', async () => {
		render(AddBar, { listId: LIST_ID, scanner: false });
		await screen.findByRole('combobox', { name: t('add_label') });
		expect(screen.queryByRole('button', { name: t('scan_title') })).toBeNull();
	});
});

// [D-271] A list pasted into the add field is not one item's name.
describe('AddBar — a pasted list', () => {
	function paste(input: HTMLElement, text: string): boolean {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		const event = new ClipboardEvent('paste', {
			clipboardData: data,
			bubbles: true,
			cancelable: true
		});
		return input.dispatchEvent(event);
	}

	it("hands two lines or more to this list's import review", async () => {
		render(AddBar, { listId: LIST_ID });
		const input = screen.getByRole('combobox');

		const notHandled = paste(input, 'Milch\n2 Brot\n\nEier');

		expect(notHandled).toBe(false);
		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith(`/list/${LIST_ID}/import`, expect.anything())
		);
		expect(importHandoff()).toBe('Milch\n2 Brot\n\nEier');
	});

	it('leaves one line to the field, as a name', () => {
		render(AddBar, { listId: LIST_ID });
		const input = screen.getByRole('combobox');

		expect(paste(input, 'Milch\n')).toBe(true);
		expect(vi.mocked(goto)).not.toHaveBeenCalled();
		expect(importHandoff()).toBe('');
	});
});
