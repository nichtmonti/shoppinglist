// §9.1 "List view (rows) — planning & editing": locale-collation, the inline
// free-text quantity editor, the sort-order criterion (the list's categories,
// Others-last), the detail sheet's edit/remove path and the swipe that also
// removes ([D-289]). The list view has NO check-off or bought-item controls
// on its rows.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db, type Item, type ListCategory } from '#lib/db.js';
import {
	makeCategory,
	makeItem,
	makeTemplate,
	putSynced,
	resetDb,
	seedList,
	untilLoaded,
	updateSynced
} from '#lib/test-kit/db.js';
import { listRememberedItems } from '#lib/state/data.js';
import { daysAgo } from '#lib/test-kit/time.js';
import { itemSort } from '#lib/state/prefs.js';
import { getLocale, setLocale, t } from '#lib/i18n/index.js';
import { showToast } from '#lib/toasts.js';
import ListView from './ListView.svelte';

vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({}, { show: true })
);

const LIST_ID = 'list-1';

async function renderList() {
	render(ListView, { listId: LIST_ID });
	// The stores are liveQuery-backed and emit asynchronously (fake-indexeddb) —
	// wait for the initial render to settle before asserting anything.
	await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
}

beforeEach(async () => {
	await resetDb();
	await itemSort.set('az');
	vi.clearAllMocks();
});

describe('ListView — previous-items entry point (§6.10)', () => {
	// The link is not gated on previousCount > 0: §6.10's buckets can be empty
	// through no fault of the user (a list whose every tick is on the current
	// trip [D-18] has nothing aged out yet), and this is the
	// only route to the view. The destination has its own designed empty state
	// for this case.
	it('offers the link even when nothing has aged into "previous" yet', async () => {
		await seedList({
			listId: LIST_ID,
			items: [makeItem({ list: LIST_ID, name: 'Milch', checked: false })]
		});
		await renderList();

		const link = screen.getByRole('button', { name: t('history_previous_items') });
		expect(link).not.toBeNull();
		// No count when there is nothing to count — the link stays, the number
		// only rides along once §6.10 has something to report.
		expect(link.querySelector('.prev-n')).toBeNull();
	});

	it('carries the count once rows have aged out of the current trip', async () => {
		const old = daysAgo(40);
		await seedList({
			listId: LIST_ID,
			items: [
				makeItem({ list: LIST_ID, name: 'Spülmittel', checked: true, checked_at: old }),
				makeItem({ list: LIST_ID, name: 'Schokolade', checked: true, checked_at: old })
			]
		});
		await renderList();

		await waitFor(() => {
			// The count is the row's value, part of its name.
			expect(
				screen.getByRole('button', { name: new RegExp(t('history_previous_items') + '.*2') })
			).toBeDefined();
		});
	});
});

describe('ListView — the planning row carries no purchase date ([D-18])', () => {
	// No 'Zuletzt' badge on a planning row: the date lives on the two surfaces
	// that actually ask the question (the previous-items screen, and the add
	// bar's own suggestions). Pinned here so it cannot creep back onto the
	// planning list, where it would annotate a row the user has already decided
	// about.
	it('renders no date on a re-activated row, however recent the purchase', async () => {
		await seedList({
			listId: LIST_ID,
			items: [
				makeItem({
					list: LIST_ID,
					name: 'Joghurt',
					checked: false,
					last_bought_at: daysAgo(2)
				})
			]
		});
		await renderList();

		const row = await screen.findByTestId('row');
		// Assert the row actually rendered, so the absence below is not vacuous.
		expect(row.textContent).toContain('Joghurt');
		expect(row.querySelector('.row-bought')).toBeNull();
		expect(row.textContent).not.toContain('Zuletzt');
	});
});

describe('ListView — A→Z (locale-collation)', () => {
	it('collates active items with the §9.1 collator: base letters, numeric-aware', async () => {
		await seedList({
			listId: LIST_ID,
			items: [
				makeItem({ list: LIST_ID, name: 'Zucker' }),
				makeItem({ list: LIST_ID, name: 'Apfel 10' }),
				makeItem({ list: LIST_ID, name: 'Äpfel' }),
				makeItem({ list: LIST_ID, name: 'Apfel 2' })
			]
		});

		await renderList();

		const names = await waitFor(() => {
			const rows = Array.from(document.querySelectorAll('.row-name-main'));
			expect(rows.length).toBe(4);
			return rows.map((el) => el.textContent);
		});

		// Base-sensitivity collation folds Ä/A together, so "Äpfel" (nothing after
		// the base letters) sorts before "Apfel 2"/"Apfel 10"; numeric:true then
		// orders "2" before "10" rather than lexically ("1" < "2").
		expect(names).toEqual(['Äpfel', 'Apfel 2', 'Apfel 10', 'Zucker']);
	});
});

describe('ListView — by-category sort', () => {
	async function seedCategorized() {
		const produce: ListCategory = makeCategory({
			id: 'cat-produce',
			list: LIST_ID,
			slug: 'produce',
			name: 'Obst & Gemüse',
			sort_order: 1
		});
		const dairy: ListCategory = makeCategory({
			id: 'cat-dairy',
			list: LIST_ID,
			slug: 'dairy',
			name: 'Milchprodukte',
			sort_order: 2
		});
		const other: ListCategory = makeCategory({
			id: 'cat-other',
			list: LIST_ID,
			slug: 'other',
			name: null,
			sort_order: 0 // deliberately low sort_order — Others must still land last
		});
		await seedList({
			listId: LIST_ID,
			categories: [produce, dairy, other],
			templates: [
				makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse', en: 'Produce' } }),
				makeTemplate({ slug: 'dairy', name_i18n: { de: 'Milchprodukte', en: 'Dairy' } }),
				makeTemplate({ slug: 'other', name_i18n: { de: 'Sonstiges', en: 'Other' } })
			],
			items: [
				makeItem({ list: LIST_ID, name: 'Milch', category_key: 'cat-dairy' }),
				makeItem({ list: LIST_ID, name: 'Apfel', category_key: 'cat-produce' }),
				makeItem({ list: LIST_ID, name: 'Käse', category_key: 'cat-dairy' }),
				// null category_key falls back to Others (§6.6).
				makeItem({ list: LIST_ID, name: 'Deo', category_key: null })
			]
		});
	}

	it('groups under aisle headers in aisle order, Others last, A→Z within each — and drops the row chip', async () => {
		await seedCategorized();
		await itemSort.set('category');
		await renderList();

		// Category names + the per-item avatar both depend on the (separately
		// liveQuery-backed) templates/categories mirrors, which can resolve a tick
		// after the items store — so assert the full settled shape in one waitFor
		// rather than snapshotting the DOM the instant the header count is right.
		await waitFor(() => {
			const heads = Array.from(document.querySelectorAll('.cat-head-name')).map(
				(el) => el.textContent
			);
			expect(heads).toEqual(['Obst & Gemüse', 'Milchprodukte', 'Sonstiges']);
		});

		const names = Array.from(document.querySelectorAll('.row-name-main')).map(
			(el) => el.textContent
		);
		// produce (Apfel) → dairy (Käse, Milch A→Z) → Others (Deo), last despite its sort_order.
		expect(names).toEqual(['Apfel', 'Käse', 'Milch', 'Deo']);

		// §9.1: the sticky category header already conveys the category, so the
		// per-row chip is dropped in category mode (a scanned photo would still show).
		expect(document.querySelectorAll('.cat-chip').length).toBe(0);
	});

	it('shows the per-row category chip in A→Z mode', async () => {
		await seedCategorized();
		await itemSort.set('az');
		await renderList();

		await waitFor(() => {
			expect(document.querySelectorAll('.row-name-main').length).toBe(4);
			expect(document.querySelectorAll('.cat-chip').length).toBeGreaterThan(0);
		});
	});

	// The scan-provenance marker is a CAMERA in a filled disc on the chip
	// corner — mirroring ScanButton's glyph, the control that creates these
	// rows. Pinned so the badge (and its scanned-only gating) cannot silently
	// change into an anonymous dot, or spread to plain rows.
	it('badges a scanned row with the camera mark on the chip corner, and only that row', async () => {
		// The chip only renders when the row resolves to a category, so seed
		// one explicitly — seedList alone ships no list_categories.
		const pantry = makeCategory({ list: LIST_ID, name: 'Pantry' });
		await db.list_categories.put(pantry);
		await seedList({
			listId: LIST_ID,
			items: [
				makeItem({
					list: LIST_ID,
					name: 'Nutella',
					barcode: '3017620422003',
					category_key: pantry.id
				}),
				makeItem({ list: LIST_ID, name: 'Mehl', category_key: pantry.id })
			]
		});
		await renderList();

		await waitFor(() => {
			expect(document.querySelectorAll('.cat-chip').length).toBe(2);
			const badges = document.querySelectorAll('.cat-chip-scan');
			expect(badges).toHaveLength(1);
			// The camera, not a bare dot: white-on-primary inside the disc.
			expect(badges[0].querySelector('svg')?.classList.contains('lucide-camera')).toBe(true);
			expect(badges[0].classList.contains('bg-primary')).toBe(true);
		});
	});
});

describe('ListView — inline free-text quantity editor', () => {
	// WCAG 2.5.3 Label in Name: the name starts with what the chip shows, and
	// says which item it belongs to, so rows are told apart by name.
	it('names the quantity chip by its value and its item', async () => {
		const milk = makeItem({ list: LIST_ID, name: 'Milch', quantity: '2 l' });
		const bread = makeItem({ list: LIST_ID, name: 'Brot', quantity: '' });
		await seedList({ listId: LIST_ID, items: [milk, bread] });
		await renderList();

		expect(
			await screen.findByRole('button', { name: '2 l – Menge bearbeiten: Milch' })
		).toBeDefined();
		expect(screen.getByRole('button', { name: 'Menge hinzufügen: Brot' })).toBeDefined();
	});

	it('opens a text input on the chip, commits the typed string verbatim, and Escape cancels', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Bananen', quantity: '6' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		expect(await screen.findByText('Bananen')).toBeDefined();

		const chip = screen.getByRole('button', { name: new RegExp(t('list_edit_quantity')) });
		expect(chip.textContent?.trim()).toBe('6');

		await fireEvent.click(chip);
		const input = await screen.findByRole('textbox', {
			name: t('list_edit_quantity')
		});

		await fireEvent.input(input, { target: { value: '500 g' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(async () => {
			const stored = await db.items.get(item.id);
			// A string, unparsed and unstepped — [D-20].
			expect(stored?.quantity).toBe('500 g');
		});

		// The chip is back (input closed) and shows the committed value. The row
		// re-render that swaps input→button (QuantityControl's `editing` state) can beat
		// the Dexie liveQuery re-emit that carries the new quantity into the item
		// store, so allow it to catch up rather than asserting on the first paint.
		let chipAfterCommit = await screen.findByRole('button', {
			name: new RegExp(t('list_edit_quantity'))
		});
		await waitFor(() => {
			chipAfterCommit = screen.getByRole('button', { name: new RegExp(t('list_edit_quantity')) });
			expect(chipAfterCommit.textContent?.trim()).toBe('500 g');
		});

		// Reopen and cancel via Escape — no write should happen.
		await fireEvent.click(chipAfterCommit);
		const input2 = await screen.findByRole('textbox', {
			name: t('list_edit_quantity')
		});
		await fireEvent.input(input2, { target: { value: 'a bunch' } });
		await fireEvent.keyDown(input2, { key: 'Escape' });

		await waitFor(() => {
			expect(screen.queryByRole('textbox', { name: t('list_edit_quantity') })).toBeNull();
		});

		const stored = await db.items.get(item.id);
		expect(stored?.quantity).toBe('500 g');
		const chipAfterEscape = await screen.findByRole('button', {
			name: new RegExp(t('list_edit_quantity'))
		});
		expect(chipAfterEscape.textContent?.trim()).toBe('500 g');
	});

	// `addItem` defaults quantity to '', which rendered straight into a filled
	// pill would be an unlabelled ~14×17px box with no text and no border:
	// invisible, well under the 44px touch minimum, and nothing on screen would
	// say a quantity could be set at all.
	it('offers a distinctly labelled control when no quantity is set yet', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Milch', quantity: '' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		expect(await screen.findByText('Milch')).toBeDefined();

		// Named for what it does in this state — "add", not "edit".
		const chip = screen.getByRole('button', {
			name: new RegExp(t('list_add_quantity_named', { name: 'Milch' }))
		});
		expect(screen.queryByRole('button', { name: new RegExp(t('list_edit_quantity')) })).toBeNull();
		// The dashed pill is labelled with the add-quantity cue (+ Menge): a
		// glyphless pill read as a rendering artifact, not a control.
		expect(chip.textContent?.trim()).toBe(`+ ${t('common_quantity')}`);

		// And it opens the same editor the set state does.
		await fireEvent.click(chip);
		const input = await screen.findByRole('textbox', { name: t('list_edit_quantity') });
		await fireEvent.input(input, { target: { value: '2 l' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(async () => {
			expect((await db.items.get(item.id))?.quantity).toBe('2 l');
		});
		// Having a value flips it back to the edit affordance.
		await waitFor(() => {
			expect(
				screen.getByRole('button', { name: new RegExp(t('list_edit_quantity')) })
			).toBeDefined();
			expect(
				screen.queryByRole('button', {
					name: new RegExp(t('list_add_quantity_named', { name: 'Milch' }))
				})
			).toBeNull();
		});
	});
});

describe('ListView — planning mode boundary', () => {
	it('does not expose any check-off control — list view is for planning only', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Milch' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		expect(await screen.findByText('Milch')).toBeDefined();

		expect(
			screen.queryByRole('button', { name: t('shop_check_tile', { name: 'Milch' }) })
		).toBeNull();
	});
});

describe('ListView — detail sheet', () => {
	// A co-shopper checking the row closes the sheet (the plan shows active
	// rows only); unchecking it again must not bring the sheet back unasked.
	it('stays closed when the row it was showing leaves and comes back', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', checked: false });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		await fireEvent.click(await screen.findByRole('button', { name: 'Senf' }));
		await screen.findByRole('dialog');

		await updateSynced(item.id, { checked: true, checked_at: new Date().toISOString() });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await updateSynced(item.id, { checked: false, checked_at: null });
		await screen.findByRole('button', { name: 'Senf' });
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('edits name/note/category and removes (tombstones) the row', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', note: null, category_key: null });
		const other = makeCategory({
			id: 'cat-other',
			list: LIST_ID,
			slug: 'other',
			name: null,
			sort_order: 0
		});
		const spices = makeCategory({
			id: 'cat-spices',
			list: LIST_ID,
			slug: null,
			name: 'Gewürze',
			sort_order: 1
		});
		await seedList({
			listId: LIST_ID,
			items: [item],
			categories: [other, spices],
			templates: [makeTemplate({ slug: 'other', name_i18n: { de: 'Sonstiges', en: 'Other' } })]
		});
		await renderList();

		expect(await screen.findByText('Senf')).toBeDefined();
		expect(screen.queryByRole('button', { name: t('list_remove', { name: 'Senf' }) })).toBeNull();

		// The row name itself opens the sheet (the chip is the other door).
		const openBtn = screen.getByRole('button', { name: 'Senf' });
		await fireEvent.click(openBtn);

		const dialog = await screen.findByRole('dialog');
		const nameInput = within(dialog).getByLabelText(t('common_name'));
		await fireEvent.input(nameInput, { target: { value: 'Scharfer Senf' } });

		const noteInput = within(dialog).getByLabelText(t('common_note'));
		await fireEvent.input(noteInput, { target: { value: 'die scharfe Sorte' } });

		// findBy, not getBy: the categories arrive on a liveQuery, so the radio
		// group can render a tick later than the sheet's text fields.
		const categoryOption = await within(dialog).findByRole('radio', { name: /Gewürze/ });
		await fireEvent.click(categoryOption);

		// Confirm is implicit: the category tap commits immediately, and the
		// still-focused note field commits on blur when the sheet is dismissed.
		const closeBtn = within(dialog).getByRole('button', { name: t('common_close') });
		await fireEvent.click(closeBtn);

		await waitFor(async () => {
			const stored = await db.items.get(item.id);
			expect(stored?.name).toBe('Scharfer Senf');
			expect(stored?.note).toBe('die scharfe Sorte');
			expect(stored?.category_key).toBe('cat-spices');
		});

		// Closing the sheet flushed the drafts; reopen it (the row is renamed)
		// for its remove path. Prefix regex, not an exact name: the
		// row-name button's accessible name carries the note too ("Scharfer
		// Senf die scharfe Sorte"), and the row has no other control whose name
		// starts with the name.
		const renamedBtn = await screen.findByRole('button', { name: /^Scharfer Senf/ });
		await fireEvent.click(renamedBtn);
		const reopened = await screen.findByRole('dialog');
		const removeBtn = within(reopened).getByRole('button', {
			name: t('list_remove', { name: 'Scharfer Senf' })
		});
		await fireEvent.click(removeBtn);

		await waitFor(async () => {
			const stored = (await db.items.get(item.id)) as Item;
			expect(stored.deleted_at).not.toBeNull();
		});
	});

	// [D-21]: the sheet shows a scanned item in the viewer's language; leaving
	// it untouched sends nothing, and a rename is one name for everyone.
	it('edits a scanned item by the name the viewer sees, and a rename clears the others', async () => {
		const previous = getLocale();
		setLocale('de');
		try {
			const item = makeItem({
				list: LIST_ID,
				name: 'Pâte à tartiner',
				name_de: 'Nuss-Nougat-Creme',
				name_en: 'Hazelnut spread'
			});
			await seedList({ listId: LIST_ID, items: [item] });
			await renderList();

			await fireEvent.click(await screen.findByRole('button', { name: 'Nuss-Nougat-Creme' }));
			let dialog = await screen.findByRole('dialog');
			expect(within(dialog).getByLabelText(t('common_name'))).toHaveProperty(
				'value',
				'Nuss-Nougat-Creme'
			);
			await fireEvent.click(within(dialog).getByRole('button', { name: t('common_close') }));
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			expect(await db.pending_ops.where('record_id').equals(item.id).count()).toBe(0);

			await fireEvent.click(screen.getByRole('button', { name: 'Nuss-Nougat-Creme' }));
			dialog = await screen.findByRole('dialog');
			await fireEvent.input(within(dialog).getByLabelText(t('common_name')), {
				target: { value: 'Nutella' }
			});
			await fireEvent.click(within(dialog).getByRole('button', { name: t('common_close') }));

			await waitFor(async () => {
				const stored = await db.items.get(item.id);
				expect([stored?.name, stored?.name_de, stored?.name_en]).toEqual(['Nutella', null, null]);
			});
			expect(await screen.findByRole('button', { name: 'Nutella' })).toBeDefined();
		} finally {
			setLocale(previous);
		}
	});

	it('shows and edits the quantity field', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', quantity: '2 Gläser' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		expect(await screen.findByText('Senf')).toBeDefined();

		const openBtn = screen.getByRole('button', { name: 'Senf' });
		await fireEvent.click(openBtn);

		const dialog = await screen.findByRole('dialog');
		const qtyInput = within(dialog).getByLabelText(t('common_quantity'));
		expect(qtyInput).toBeDefined();
		expect((qtyInput as HTMLInputElement).value).toBe('2 Gläser');

		await fireEvent.input(qtyInput, { target: { value: '3 Flaschen' } });
		await fireEvent.blur(qtyInput);

		await waitFor(async () => {
			const stored = await db.items.get(item.id);
			expect(stored?.quantity).toBe('3 Flaschen');
		});
	});

	// The implicit-confirm contract's other half: with nothing changed,
	// closing is a plain close — no write, no op, row byte-identical after.
	it('closing with no changes just closes', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', note: null, category_key: null });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		expect(await screen.findByText('Senf')).toBeDefined();

		await fireEvent.click(screen.getByRole('button', { name: 'Senf' }));
		const dialog = await screen.findByRole('dialog');
		await fireEvent.click(within(dialog).getByRole('button', { name: t('common_close') }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		const stored = await db.items.get(item.id);
		expect(stored?.name).toBe('Senf');
		expect(stored?.note).toBeNull();
		expect(stored?.category_key).toBeNull();
	});

	// A co-member's edit arriving while the sheet is open moves the row, not the
	// drafts: closing untouched must not send the old values back, which the
	// server would take without a conflict, the op's base being theirs (§8.4).
	it('closing untouched keeps a co-member edit that arrived while it was open', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', quantity: '1', note: 'scharf' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		await fireEvent.click(await screen.findByRole('button', { name: /^Senf/ }));
		const dialog = await screen.findByRole('dialog');
		await putSynced([{ ...item, quantity: '2', note: 'süß', updated: '2026-10-09T08:00:00.000Z' }]);
		// The row behind the sheet has it, so the sheet's item has too.
		await screen.findByRole('button', { name: /^2 .*Senf/, hidden: true });
		await fireEvent.blur(within(dialog).getByLabelText(t('common_quantity')));
		await fireEvent.click(within(dialog).getByRole('button', { name: t('common_close') }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(await db.pending_ops.count()).toBe(0);
		const stored = await db.items.get(item.id);
		expect([stored?.quantity, stored?.note]).toEqual(['2', 'süß']);
	});

	// A co-shopper ticks the item off while its sheet is open: the row leaves
	// the planning surface and the sheet with it, without a close. What was
	// typed must still commit.
	it('commits what was typed when the open row is ticked off elsewhere', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', note: null });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		await fireEvent.click(await screen.findByRole('button', { name: /^Senf/ }));
		const dialog = await screen.findByRole('dialog');
		await fireEvent.input(within(dialog).getByLabelText(t('common_note')), {
			target: { value: 'scharf' }
		});
		const now = '2026-10-09T08:00:00.000Z';
		await putSynced([
			{ ...item, checked: true, checked_at: now, last_bought_at: now, updated: now }
		]);

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(async () => expect((await db.items.get(item.id))?.note).toBe('scharf'));
	});

	// [D-293] Switching to another app may be the last this page sees (iOS
	// unloads it in the background): what was typed commits on the way out.
	it('commits what was typed when the app goes to the background', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', note: null });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		await fireEvent.click(await screen.findByRole('button', { name: /^Senf/ }));
		const dialog = await screen.findByRole('dialog');
		await fireEvent.input(within(dialog).getByLabelText(t('common_note')), {
			target: { value: 'scharf' }
		});
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		visibility.mockRestore();

		await waitFor(async () => expect((await db.items.get(item.id))?.note).toBe('scharf'));
		// The sheet stays open for the return.
		expect(screen.getByRole('dialog')).toBeDefined();
	});

	// An emptied name must never blank the row: ItemDetailSheet's commit() drops the name from
	// the patch but still commits the other changed fields in the same op.
	it('an emptied name keeps the current name and commits other deltas', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', note: null, category_key: null });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();

		expect(await screen.findByText('Senf')).toBeDefined();

		await fireEvent.click(screen.getByRole('button', { name: 'Senf' }));
		const dialog = await screen.findByRole('dialog');
		const nameInput = within(dialog).getByLabelText(t('common_name'));
		await fireEvent.input(nameInput, { target: { value: '   ' } });
		const noteInput = within(dialog).getByLabelText(t('common_note'));
		await fireEvent.input(noteInput, { target: { value: 'die scharfe Sorte' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: t('common_close') }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		const stored = await db.items.get(item.id);
		expect(stored?.name).toBe('Senf');
		expect(stored?.note).toBe('die scharfe Sorte');
	});

	// The server merges names only on an add (§8.3): a rename into a name
	// another row has would show it twice.
	it('does not save a rename into a name another row has, and says so', async () => {
		const oat = makeItem({ list: LIST_ID, name: 'Hafermilch', note: null });
		const milk = makeItem({ list: LIST_ID, name: 'Milch' });
		await seedList({ listId: LIST_ID, items: [oat, milk] });
		await renderList();

		expect(await screen.findByText('Hafermilch')).toBeDefined();
		await fireEvent.click(screen.getByRole('button', { name: 'Hafermilch' }));
		const dialog = await screen.findByRole('dialog');
		// The rows a rename is checked against load as the sheet opens.
		await untilLoaded(listRememberedItems(LIST_ID));
		await fireEvent.input(within(dialog).getByLabelText(t('common_name')), {
			target: { value: ' milch ' }
		});
		await fireEvent.input(within(dialog).getByLabelText(t('common_note')), {
			target: { value: 'Barista' }
		});
		await fireEvent.click(within(dialog).getByRole('button', { name: t('common_close') }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(async () => expect((await db.items.get(oat.id))?.note).toBe('Barista'));
		expect((await db.items.get(oat.id))?.name).toBe('Hafermilch');
		expect(showToast).toHaveBeenCalledWith(t('add_dedup_active', { name: 'milch' }));
	});

	// The chip shows the aisle and the sheet is where the aisle is changed, so
	// the chip opens it too — not an inert span, a dead target in the middle of
	// the row.
	it('opens from the row category chip, not just the ⋯', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf', category_key: 'cat-spices' });
		await seedList({
			listId: LIST_ID,
			items: [item],
			categories: [
				makeCategory({
					id: 'cat-spices',
					list: LIST_ID,
					slug: null,
					name: 'Gewürze',
					sort_order: 1
				})
			]
		});
		// A→Z: the chip only rides along when rows are not already grouped by category.
		await itemSort.set('az');
		await renderList();

		expect(await screen.findByText('Senf')).toBeDefined();
		expect(screen.queryByRole('dialog')).toBeNull();

		// findBy, not getBy: items and categories arrive on separate liveQueries,
		// so the row can render a tick before its category is known.
		const chip = await screen.findByRole('button', {
			name: t('list_row_category', { category: 'Gewürze', name: 'Senf' })
		});
		await fireEvent.click(chip);

		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByLabelText<HTMLInputElement>(t('common_name')).value).toBe('Senf');
	});
});

describe('ListView — a swipe to the left removes ([D-289])', () => {
	// happy-dom lays nothing out, so the row is 0px wide and the threshold is
	// the 96px floor.
	async function swipe(row: HTMLElement, dx: number, dy = 0): Promise<void> {
		// A mouse's events, as Playwright's swipe sends them; every browser
		// pointer event names its type.
		const at = {
			clientX: 300,
			clientY: 100,
			pointerId: 1,
			isPrimary: true,
			button: 0,
			buttons: 1,
			pointerType: 'mouse'
		};
		await fireEvent.pointerDown(row, at);
		for (const step of [0.25, 0.5, 0.75, 1]) {
			await fireEvent.pointerMove(row, {
				...at,
				clientX: at.clientX + dx * step,
				clientY: at.clientY + dy * step
			});
		}
		await fireEvent.pointerUp(row, { ...at, clientX: at.clientX + dx, clientY: at.clientY + dy });
	}

	async function rowOf(name: string): Promise<HTMLElement> {
		const button = await screen.findByRole('button', { name });
		return button.closest<HTMLElement>('[data-testid="row"]')!;
	}

	it('removes the item past the threshold and opens no sheet', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();
		const row = await rowOf('Senf');

		await swipe(row, -160);
		// The click that ends the drag lands on the name: it must not open the
		// sheet. detail 1, as a browser's pointer click carries.
		await fireEvent.click(within(row).getByRole('button', { name: 'Senf' }), { detail: 1 });
		expect(screen.queryByRole('dialog')).toBeNull();

		await waitFor(async () => {
			const stored = (await db.items.get(item.id)) as Item;
			expect(stored.deleted_at).not.toBeNull();
		});
	});

	it('removes on a flick short of the threshold', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();
		const row = await rowOf('Senf');

		// fireEvent's moves come microseconds apart: 60px is a flick.
		await swipe(row, -60);

		await waitFor(async () => {
			const stored = (await db.items.get(item.id)) as Item;
			expect(stored.deleted_at).not.toBeNull();
		});
	});

	it('snaps back short of the threshold, and a drag the other way does nothing', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();
		const row = await rowOf('Senf');

		// Under the flick's distance too: fireEvent's moves come microseconds
		// apart, so any longer drag here is a flick.
		await swipe(row, -40);
		await swipe(row, 200);
		await new Promise((r) => setTimeout(r, 250));

		expect(row.style.getPropertyValue('--swipe-x')).toBe('');
		expect(document.querySelector('[data-testid="swipe-under"]')).toBeNull();
		expect(((await db.items.get(item.id)) as Item).deleted_at).toBeNull();
	});

	it('leaves a vertical drag to the scroll', async () => {
		const item = makeItem({ list: LIST_ID, name: 'Senf' });
		await seedList({ listId: LIST_ID, items: [item] });
		await renderList();
		const row = await rowOf('Senf');

		await swipe(row, -160, 300);
		await new Promise((r) => setTimeout(r, 250));

		expect(row.style.getPropertyValue('--swipe-x')).toBe('');
		expect(((await db.items.get(item.id)) as Item).deleted_at).toBeNull();
	});
});

describe('ListView — checked rows do not appear here at all ([D-18])', () => {
	// The planning view carries no copy of the shop's done pile: the list view
	// has no check-off control (§9.1), so it has no business carrying an
	// UN-check one —
	// and yesterday's finished shopping is not an input to planning the next
	// trip. Restoring lives where checking off does, one tap away on the
	// Einkaufen/Bearbeiten control.
	it('keeps a row checked off this trip out of the planning surface', async () => {
		const cat = makeCategory({ list: LIST_ID, slug: 'produce', name: 'Obst', sort_order: 1 });
		await seedList({
			listId: LIST_ID,
			categories: [cat],
			items: [
				makeItem({ list: LIST_ID, name: 'Milch', checked: false }),
				makeItem({
					list: LIST_ID,
					name: 'Käse',
					category_key: cat.id,
					checked: true,
					checked_at: new Date().toISOString()
				})
			]
		});
		await renderList();

		// The active row renders, so the absences below are not vacuous.
		await waitFor(() =>
			expect(screen.getAllByTestId('row').some((r) => r.textContent?.includes('Milch'))).toBe(true)
		);
		expect(screen.queryByTestId('recent-row')).toBeNull();
		expect(screen.queryByTestId('recent-head')).toBeNull();
		expect(screen.queryAllByTestId('row').some((r) => r.textContent?.includes('Käse'))).toBe(false);
	});

	it('shows the all-done state, and the previous-items door, with nothing between', async () => {
		// With the section gone, a fully-checked list is the empty state plus the
		// door — the two things that still have something to say.
		await seedList({
			listId: LIST_ID,
			items: [
				makeItem({
					list: LIST_ID,
					name: 'Käse',
					checked: true,
					checked_at: new Date().toISOString()
				})
			]
		});
		await renderList();

		await waitFor(() => expect(document.querySelector('.all-done')).not.toBeNull());
		expect(screen.queryByTestId('recent-row')).toBeNull();
		expect(document.querySelector('.prev-link')).not.toBeNull();
	});
});

describe("ListView — the list's last row paints no separator ([D-128])", () => {
	// §9.1's row rule is INSET, so it means "another row below"; a full-bleed
	// rule means "a new section". The tail had both: the last row's rule, then
	// PrevItemsLink's section rule, read as two lines under the list. The rule
	// is an ::after utility, so its absence is the class's absence.
	const ruled = () =>
		screen.getAllByTestId('row').map((row) => row.className.includes('after:h-px'));

	it('rules every row but the last of each aisle, grouped by category', async () => {
		const produce = makeCategory({
			id: 'cat-produce',
			list: LIST_ID,
			slug: 'produce',
			name: 'Obst',
			sort_order: 1
		});
		const dairy = makeCategory({
			id: 'cat-dairy',
			list: LIST_ID,
			slug: 'dairy',
			name: 'Milch',
			sort_order: 2
		});
		await seedList({
			listId: LIST_ID,
			categories: [produce, dairy],
			items: [
				makeItem({ list: LIST_ID, name: 'Apfel', category_key: 'cat-produce' }),
				makeItem({ list: LIST_ID, name: 'Banane', category_key: 'cat-produce' }),
				makeItem({ list: LIST_ID, name: 'Käse', category_key: 'cat-dairy' })
			]
		});
		await itemSort.set('category');
		await renderList();

		await waitFor(() => expect(screen.getAllByTestId('row').length).toBe(3));
		// The rule survives INSIDE a group (Apfel→Banane) and stops at each
		// group's end: the next aisle header is ruled itself ([D-332]).
		expect(ruled()).toEqual([true, false, false]);
		expect(document.querySelector('.prev-link')).not.toBeNull();
	});

	it('rules every row but the last one, A→Z', async () => {
		await seedList({
			listId: LIST_ID,
			items: [makeItem({ list: LIST_ID, name: 'Apfel' }), makeItem({ list: LIST_ID, name: 'Brot' })]
		});
		await itemSort.set('az');
		await renderList();

		await waitFor(() => expect(screen.getAllByTestId('row').length).toBe(2));
		expect(ruled()).toEqual([true, false]);
	});

	it('leaves a single-row list unruled', async () => {
		await seedList({
			listId: LIST_ID,
			items: [makeItem({ list: LIST_ID, name: 'Apfel' })]
		});
		await renderList();

		await waitFor(() => expect(screen.getAllByTestId('row').length).toBe(1));
		expect(ruled()).toEqual([false]);
	});
});
