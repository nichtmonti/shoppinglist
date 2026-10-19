// The category color rendering (header + badge tint, Others gray) and the color
// picker in the category editor.
// Harness pattern per src/lib/components/history/previous-items.svelte.test.ts
// (goto/resolve mocks) and src/lib/components/list/list-view.svelte.test.ts
// (detail-sheet open/interact/assert-Dexie pattern; also that file's note that
// two separate liveQuery-backed stores — here list_categories and
// category_templates — can settle a tick apart, so assertions that depend on
// BOTH must go through waitFor rather than reading the DOM the instant the
// first store's rows appear).
import { subScreen } from '#lib/components/common/sub-screen.svelte.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The router is the test kit's fake history (test-kit/component-setup.ts): the
// arrange mode is an entry in it, and goto is spied on over it.
vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});
vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

// Captured, not shown: the hide's toast text is asserted directly.
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({ showToast })
);
// The one route-backed action; the rest stay real.
vi.mock('#lib/actions/categories.js', async () => ({
	...(await vi.importActual<object>('#lib/actions/categories.js')),
	addMissingCategories: vi.fn().mockResolvedValue(['hardware'])
}));
import { goto } from '$app/navigation';
import contract from '../../../../../backend/internal/fieldcontract/field-contract.json';
import { db } from '#lib/db.js';
import { makeCategory, makeTemplate, resetDb, seedList } from '#lib/test-kit/db.js';
import { COLOR_LABEL_KEYS, PALETTE } from '#lib/categories.js';
import { t } from '#lib/i18n/index.js';
import * as appState from '#lib/test-kit/app-state.svelte.js';
import CategoryEditor from './CategoryEditor.svelte';
import { addMissingCategories, persistReorder } from '#lib/actions/categories.js';

const LIST_ID = 'list-1';

function rowFor(id: string): HTMLElement {
	const el = document.querySelector(`.catedit-row[data-category-id="${id}"]`);
	if (!el) throw new Error(`visible row not found: ${id}`);
	return el as HTMLElement;
}

function hiddenRowFor(id: string): HTMLElement | null {
	return document.querySelector(`.hidden-row[data-category-id="${id}"]`);
}

function labelOf(row: HTMLElement): string | null {
	return row.querySelector('.ce-label')?.textContent ?? null;
}

async function seedStandard() {
	const produce = makeCategory({
		id: 'cat-produce',
		list: LIST_ID,
		slug: 'produce',
		name: null,
		icon: '🥦',
		color: 'green',
		sort_order: 1
	});
	const dairy = makeCategory({
		id: 'cat-dairy',
		list: LIST_ID,
		slug: 'dairy',
		name: 'Molkerei', // renamed away from the template default
		icon: '🥛',
		color: 'sky',
		sort_order: 2
	});
	const other = makeCategory({
		id: 'cat-other',
		list: LIST_ID,
		slug: 'other',
		name: null,
		icon: '📦',
		color: 'gray',
		sort_order: 0 // deliberately low — Others must still render last
	});
	await seedList({
		listId: LIST_ID,
		categories: [produce, dairy, other],
		templates: [
			makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse', en: 'Produce' } }),
			makeTemplate({ slug: 'dairy', name_i18n: { de: 'Milchprodukte', en: 'Dairy' } }),
			makeTemplate({
				slug: 'other',
				name_i18n: { de: 'Sonstiges', en: 'Other' },
				icon: '📦',
				color: 'gray'
			})
		]
	});
	return { produce, dairy, other };
}

// Renders and waits for BOTH the list_categories and category_templates
// liveQuery stores to have settled — proven by the produce row (seeded with
// name: null) showing its resolved template default rather than the raw slug.
async function renderEditor() {
	render(CategoryEditor, { props: { listId: LIST_ID } });
	await waitFor(() => {
		expect(labelOf(rowFor('cat-produce'))).toBe('Obst & Gemüse');
	});
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
});

describe('CategoryEditor — list rendering (aisle order, Others last, resolved labels)', () => {
	it('renders rows in aisle order with Others last, template default for unrenamed, custom name for renamed', async () => {
		await seedStandard();
		await renderEditor();

		const names = Array.from(document.querySelectorAll('.catedit-row .ce-label')).map(
			(el) => el.textContent
		);
		expect(names).toEqual(['Obst & Gemüse', 'Molkerei', 'Sonstiges']);
	});

	it('shows the "Standard: …" hint under a renamed seeded row, not under an unrenamed one', async () => {
		await seedStandard();
		await renderEditor();

		expect(rowFor('cat-produce').querySelector('.def')).toBeNull();
		expect(rowFor('cat-dairy').querySelector('.def')?.textContent).toBe('Standard: Milchprodukte');
	});
});

describe('CategoryEditor — Others row', () => {
	it('renders gray and offers no hide control, while an ordinary category does', async () => {
		await seedStandard();
		await renderEditor();

		const othersRow = rowFor('cat-other');
		const produceRow = rowFor('cat-produce');

		expect(othersRow.getAttribute('style')).toContain('var(--cat-gray)');
		expect(within(othersRow).queryByRole('button', { name: /ausblenden$/ })).toBeNull();
		expect(
			within(produceRow).queryByRole('button', { name: '„Obst & Gemüse“ ausblenden' })
		).not.toBeNull();
	});
});

describe('CategoryEditor — color picker', () => {
	it('offers only palette swatches labelled with localized colour names, with no free hex input anywhere', async () => {
		await seedStandard();
		await renderEditor();

		await fireEvent.click(
			within(rowFor('cat-produce')).getByRole('button', { name: '„Obst & Gemüse“ bearbeiten' })
		);

		const swatches = await waitFor(() => {
			const grid = document.querySelector('[data-testid="color-grid"]');
			expect(grid).not.toBeNull();
			const buttons = Array.from(grid!.querySelectorAll('button'));
			expect(buttons.length).toBeGreaterThan(0);
			return buttons;
		});

		expect(swatches.length).toBe(PALETTE.length);
		// aria-labels are localized colour names, not palette tokens — and
		// swatches render in {#each PALETTE} order, so index i maps to PALETTE[i].
		swatches.forEach((swatch, i) => {
			const label = swatch.getAttribute('aria-label');
			expect(label).not.toBeNull();
			expect(label).toBe(t(COLOR_LABEL_KEYS[PALETTE[i]]));
		});

		expect(document.querySelector('input[type="color"]')).toBeNull();
	});
});

describe('CategoryEditor — reorder', () => {
	// Two members adding a category on two devices can give both the same
	// sort_order (each takes max + 1); the editor shows them by name, and a
	// reorder between them must still land.
	it('reorders two categories that share a sort_order', async () => {
		const a = makeCategory({
			id: 'cat-a',
			list: LIST_ID,
			slug: null,
			name: 'Apotheke',
			sort_order: 3
		});
		const b = makeCategory({
			id: 'cat-b',
			list: LIST_ID,
			slug: null,
			name: 'Baumarkt',
			sort_order: 3
		});
		await seedList({ listId: LIST_ID, categories: [a, b] });

		await persistReorder([a, b], ['cat-b', 'cat-a']);

		const [freshA, freshB] = await db.list_categories.bulkGet(['cat-a', 'cat-b']);
		expect(freshB!.sort_order).toBeLessThan(freshA!.sort_order);
	});

	it('persists a drag result as sort_order swaps in Dexie', async () => {
		await seedStandard();
		const rows = await db.list_categories.where('list').equals(LIST_ID).toArray();
		const live = rows
			.filter((c) => c.deleted_at === null)
			.sort((a, b) => a.sort_order - b.sort_order);
		const ids = live.map((c) => c.id);
		const newOrder = [...ids];
		// Drag produce (sort_order 1, after Others at 0) below dairy (sort_order 2).
		[newOrder[1], newOrder[2]] = [newOrder[2], newOrder[1]];
		await persistReorder(live, newOrder);

		const produce = await db.list_categories.get('cat-produce');
		const dairy = await db.list_categories.get('cat-dairy');
		expect(produce?.sort_order).toBe(2);
		expect(dairy?.sort_order).toBe(1);
	});

	// Two arrow taps in quick succession: the second is computed before the
	// first has landed, and must still win.
	it('lands two reorders in a row in the order they were asked for', async () => {
		await seedStandard();
		const live = (await db.list_categories.where('list').equals(LIST_ID).toArray())
			.filter((c) => c.slug !== 'other')
			.sort((a, b) => a.sort_order - b.sort_order);
		expect(live.map((c) => c.id)).toEqual(['cat-produce', 'cat-dairy']);
		// Both from the same rendered rows, neither awaited before the next.
		const first = persistReorder(live, ['cat-dairy', 'cat-produce']);
		const second = persistReorder(live, ['cat-produce', 'cat-dairy']);
		await Promise.all([first, second]);

		expect((await db.list_categories.get('cat-produce'))?.sort_order).toBe(1);
		expect((await db.list_categories.get('cat-dairy'))?.sort_order).toBe(2);
	});

	// [D-90] Reordering is a mode: the editing rows never drag, and the
	// arrangement has a handle per row, no edit or hide, and arrows only on the
	// row whose handle was tapped ([D-237]).
	it('arranges in its own mode: arrows move a row, Others stays fixed, Fertig returns', async () => {
		await seedStandard();
		await renderEditor();
		// The editing rows carry no drag handle.
		expect(document.querySelector('.arrange-handle')).toBeNull();

		const arrange = screen.getByRole('button', { name: 'Reihenfolge ändern' });
		await fireEvent.click(arrange);

		const produce = await screen.findByRole('button', { name: 'Obst & Gemüse verschieben' });
		expect(screen.queryByRole('button', { name: /nach (oben|unten)$/ })).toBeNull();
		expect(screen.queryByRole('button', { name: /bearbeiten$/ })).toBeNull();
		expect(screen.queryByRole('button', { name: t('categories_add') })).toBeNull();
		// Others is shown, last, with nothing that promises a move.
		expect(screen.queryByRole('button', { name: /^Sonstiges / })).toBeNull();
		expect(screen.getByText('„Sonstiges“ bleibt immer am Ende')).toBeTruthy();
		// The ends are disabled rather than doing nothing, and a tap on another
		// handle moves the arrows there.
		await fireEvent.click(screen.getByRole('button', { name: 'Molkerei verschieben' }));
		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Molkerei nach unten' }).disabled
		).toBe(true);
		await fireEvent.click(produce);
		expect(screen.queryByRole('button', { name: /^Molkerei nach/ })).toBeNull();
		expect(produce.getAttribute('aria-pressed')).toBe('true');
		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Obst & Gemüse nach oben' }).disabled
		).toBe(true);

		await fireEvent.click(screen.getByRole('button', { name: 'Obst & Gemüse nach unten' }));
		await waitFor(async () => {
			expect((await db.list_categories.get('cat-produce'))?.sort_order).toBe(2);
			expect((await db.list_categories.get('cat-dairy'))?.sort_order).toBe(1);
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
		await waitFor(() =>
			expect(
				[...document.querySelectorAll('.catedit-row')].map((r) => labelOf(r as HTMLElement))
			).toEqual(['Molkerei', 'Obst & Gemüse', 'Sonstiges'])
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('button', { name: 'Reihenfolge ändern' })
			)
		);
	});

	it('closes the arrangement on the system back, staying on the editor', async () => {
		await seedStandard();
		await renderEditor();
		await fireEvent.click(screen.getByRole('button', { name: 'Reihenfolge ändern' }));
		await screen.findByRole('button', { name: 'Obst & Gemüse verschieben' });
		expect(appState.page.state).toEqual({ mode: 'arrange-categories' });

		appState.historyBack();
		await waitFor(() => expect(rowFor('cat-produce')).toBeTruthy());
		expect(screen.queryByRole('button', { name: 'Fertig' })).toBeNull();
		// The mode's own entry is a shallow goto; what must not happen is a
		// navigation off the editor.
		const navigations = vi.mocked(goto).mock.calls.filter(([, options]) => !options?.shallow);
		expect(navigations).toEqual([]);
	});

	it('offers no arrangement when fewer than two categories can move', async () => {
		const other = makeCategory({ id: 'cat-other', list: LIST_ID, slug: 'other', name: null });
		const produce = makeCategory({ id: 'cat-produce', list: LIST_ID, slug: 'produce', name: null });
		await seedList({
			listId: LIST_ID,
			categories: [produce, other],
			templates: [
				makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse', en: 'Produce' } }),
				makeTemplate({ slug: 'other', name_i18n: { de: 'Sonstiges', en: 'Other' } })
			]
		});
		await renderEditor();
		expect(screen.queryByRole('button', { name: 'Reihenfolge ändern' })).toBeNull();
	});
});

describe('CategoryEditor — add / edit / reset', () => {
	it('adds a new category: slug null locally, and a create the server accepts', async () => {
		await seedStandard();
		await renderEditor();

		await fireEvent.click(screen.getByRole('button', { name: 'Neue Kategorie' }));
		const nameInput = await screen.findByLabelText('Name');
		await fireEvent.input(nameInput, { target: { value: 'Tiefkühl' } });
		// pick a specific emoji + color so the write is asserted precisely
		await fireEvent.click(screen.getByRole('radio', { name: '❄️' }));
		// labels are localized colour names — the harness pins de, so this resolves to 'Hellblau'
		await fireEvent.click(screen.getByRole('radio', { name: t(COLOR_LABEL_KEYS.sky) }));
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(async () => {
			const all = await db.list_categories.toArray();
			const added = all.find((c) => c.name === 'Tiefkühl');
			expect(added).toBeDefined();
			expect(added?.slug).toBeNull();
			expect(added?.icon).toBe('❄️');
			expect(added?.color).toBe('sky');
		});

		// The row is null-slugged locally, but the OP must not name `slug` at all:
		// the server's push allowlist is the contract's writable set, and one
		// field outside it denies the whole create (field_unknown). Asserting only
		// the local row is how this shipped broken: the row looked right until
		// the next sync reverted it.
		const [op] = await db.pending_ops.toArray();
		const writable = Object.keys(contract.collections.list_categories.writable);
		expect(Object.keys(op.changed).sort()).toEqual(writable.sort());
	});

	it('renames an existing category via the edit form', async () => {
		await seedStandard();
		await renderEditor();

		await fireEvent.click(
			within(rowFor('cat-produce')).getByRole('button', { name: '„Obst & Gemüse“ bearbeiten' })
		);

		const nameInput = await screen.findByLabelText('Name');
		await fireEvent.input(nameInput, { target: { value: 'Frisches Obst' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(async () => {
			const updated = await db.list_categories.get('cat-produce');
			expect(updated?.name).toBe('Frisches Obst');
		});
	});

	it('"reset to default" clears the custom name and restores the template icon/color', async () => {
		await seedStandard();
		await renderEditor();

		await fireEvent.click(
			within(rowFor('cat-dairy')).getByRole('button', { name: '„Molkerei“ bearbeiten' })
		);

		await screen.findByLabelText('Name');
		await fireEvent.click(screen.getByRole('button', { name: 'Auf Standard zurücksetzen' }));

		await waitFor(async () => {
			const updated = await db.list_categories.get('cat-dairy');
			expect(updated?.name).toBeNull();
			expect(updated?.icon).toBe('📦');
			expect(updated?.color).toBe('gray');
		});
	});
});

// [D-251] a list made before the seed grew an aisle offers it.
describe('CategoryEditor — missing standard categories', () => {
	it('offers none when the list has every template', async () => {
		await seedStandard();
		await renderEditor();
		expect(document.querySelector('.ce-missing')).toBeNull();
	});

	it('names the templates the list lacks and adds them through the route', async () => {
		await seedStandard();
		await db.category_templates.put(
			makeTemplate({
				slug: 'hardware',
				name_i18n: { de: 'Baumarkt & Werkzeug', en: 'Hardware & DIY' },
				icon: '🔨',
				color: 'orange',
				sort_order: 18
			})
		);
		await renderEditor();

		const block = await waitFor(() => {
			const el = document.querySelector<HTMLElement>('.ce-missing');
			expect(el).not.toBeNull();
			return el!;
		});
		expect(block.textContent).toContain('Baumarkt & Werkzeug');
		await fireEvent.click(screen.getByRole('button', { name: 'Diese Kategorie hinzufügen' }));

		await waitFor(() => expect(addMissingCategories).toHaveBeenCalledWith(LIST_ID));
		await waitFor(() => expect(showToast).toHaveBeenCalledWith('1 Kategorie hinzugefügt'));
	});

	it('does not offer an aisle a member removed: the hidden section restores it', async () => {
		const { produce } = await seedStandard();
		await db.list_categories.put({ ...produce, deleted_at: '2026-10-01 10:00:00.000Z' });
		await db.category_templates.put(
			makeTemplate({ slug: 'produce', name_i18n: { de: 'Obst & Gemüse', en: 'Produce' } })
		);
		render(CategoryEditor, { props: { listId: LIST_ID } });
		await waitFor(() => expect(hiddenRowFor('cat-produce')).not.toBeNull());
		expect(document.querySelector('.ce-missing')).toBeNull();
	});
});

describe('CategoryEditor — hide / restore', () => {
	it('hides a non-Others row (tombstones it) and it moves to the hidden section; restore clears it', async () => {
		await seedStandard();
		await renderEditor();

		await fireEvent.click(
			within(rowFor('cat-produce')).getByRole('button', { name: '„Obst & Gemüse“ ausblenden' })
		);

		await waitFor(async () => {
			const updated = await db.list_categories.get('cat-produce');
			expect(updated?.deleted_at).not.toBeNull();
		});

		await waitFor(() => {
			expect(document.querySelector('.catedit-row[data-category-id="cat-produce"]')).toBeNull();
			const hidden = hiddenRowFor('cat-produce');
			expect(hidden).not.toBeNull();
			expect(hidden?.querySelector('.h-name')?.textContent).toBe('Obst & Gemüse');
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));

		await waitFor(async () => {
			const restored = await db.list_categories.get('cat-produce');
			expect(restored?.deleted_at).toBeNull();
		});
		await waitFor(() => {
			expect(rowFor('cat-produce')).not.toBeNull();
			expect(document.querySelector('.hidden-row[data-category-id="cat-produce"]')).toBeNull();
		});
	});
});

describe('CategoryEditor — hide toast', () => {
	beforeEach(async () => {
		await resetDb();
		showToast.mockClear();
	});

	// A seeded row keeps `name` null and shows its template's name; the toast
	// must say that name, not an empty pair of quotes.
	it('names an unrenamed seeded category by the name the row shows', async () => {
		await seedStandard();
		await renderEditor();

		await fireEvent.click(
			within(rowFor('cat-produce')).getByRole('button', { name: '„Obst & Gemüse“ ausblenden' })
		);

		await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
		expect(showToast.mock.calls[0][0]).toBe('„Obst & Gemüse“ ausgeblendet');
	});
});

// [D-304] The list's app bar ‹ is the one way back; the row under it is the
// screen's title, not a second ‹.
describe('CategoryEditor — title', () => {
	it("names itself in the list's app bar, with no back control of its own ([D-323])", async () => {
		await seedStandard();
		await renderEditor();

		expect(subScreen.title).toBe('Kategorien bearbeiten');
		expect(screen.queryByRole('button', { name: /Zurück/ })).toBeNull();
	});
});

describe('CategoryEditor — rows ruled like the list ([D-128], [D-326])', () => {
	// RuledRows draws the inset rule between rows, so the last row has none
	// and nothing doubles the hidden section's rule below it.
	it('puts every visible row under one RuledRows, with no border of its own', async () => {
		await seedStandard();
		await renderEditor();
		const rows = Array.from(document.querySelectorAll('.catedit-row'));
		expect(rows.length).toBeGreaterThan(1);
		const list = rows[0].parentElement!;
		expect(list.classList.contains('ruled-rows')).toBe(true);
		expect(rows.every((row) => row.parentElement === list)).toBe(true);
		expect(rows.some((row) => /\bborder-b\b/.test(row.className))).toBe(false);
	});
});
