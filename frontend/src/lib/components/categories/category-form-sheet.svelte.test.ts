// The form's resolve-by-id contract (CategoryFormSheet.svelte, category-form.ts):
// the open category is looked up by id against the live rows, so a co-member's
// edit to it becomes what Save writes over — while the drafts are seeded once
// per opening and never clobbered by that refresh, so what the user is typing
// survives it. Save sends only the fields the user changed: an untouched one
// sent as seeded would undo the co-member's edit to it, silently (§8.4).
//
// The prop `target` shares its name with a Svelte mount option, so render takes
// the props under `props`.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/actions/categories.js', () => ({
	addCategory: vi.fn(async () => {}),
	editCategory: vi.fn(async () => {}),
	resetCategoryToTemplate: vi.fn(async () => {})
}));

vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock()
);

import { addCategory, editCategory } from '#lib/actions/categories.js';
import { showToast } from '#lib/toasts.js';
import type { CategoryTemplate, ListCategory } from '#lib/db.js';
import { makeCategory } from '#lib/test-kit/db.js';
import CategoryFormSheet from './CategoryFormSheet.svelte';
import type { CategoryFormTarget } from './category-form';

const LIST_ID = 'list-1';

function props(target: CategoryFormTarget | null, categories: ListCategory[]) {
	return {
		listId: LIST_ID,
		target,
		categories,
		templates: new Map<string, CategoryTemplate>(),
		onclose: vi.fn()
	};
}

const original = makeCategory({
	id: 'cat-dairy',
	list: LIST_ID,
	name: 'Molkerei',
	icon: '🥛',
	color: 'sky'
});
// The same row after a co-member renamed it and picked another icon.
const renamed: ListCategory = { ...original, name: 'Käsetheke', icon: '🧀' };

beforeEach(() => {
	vi.mocked(editCategory).mockClear();
	vi.mocked(addCategory).mockClear();
	vi.mocked(showToast).mockClear();
});

describe('CategoryFormSheet — saving', () => {
	// A double tap on Speichern must not add the category twice: the sheet
	// closes only once the first save has been written.
	it('adds one category for a double tap', async () => {
		let finish!: () => void;
		vi.mocked(addCategory).mockImplementation(
			() => new Promise<string>((r) => (finish = () => r('cat-new')))
		);
		render(CategoryFormSheet, { props: props({ kind: 'add' }, []) });

		const save = await screen.findByRole('button', { name: 'Speichern' });
		await fireEvent.click(save);
		await fireEvent.click(save);
		finish();

		await waitFor(() => expect(addCategory).toHaveBeenCalled());
		expect(addCategory).toHaveBeenCalledTimes(1);
	});
});

// Two categories with one name cannot be told apart in the item sheet's
// picker, so the form refuses a name another one shows, hidden ones included.
describe('CategoryFormSheet — a name another category has', () => {
	const hiddenFrozen = makeCategory({
		list: LIST_ID,
		name: 'Tiefkühl',
		deleted_at: '2026-10-01T00:00:00Z'
	});

	it('does not add it, says so and stays open', async () => {
		const p = props({ kind: 'add' }, [original, hiddenFrozen]);
		render(CategoryFormSheet, { props: p });

		await fireEvent.input(await screen.findByLabelText('Name'), {
			target: { value: ' tiefkühl ' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		// Under the name, where it can be changed ([D-325]).
		expect((await screen.findByRole('alert')).textContent?.trim()).toBe(
			'Die Kategorie „tiefkühl“ gibt es schon'
		);
		expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
		expect(addCategory).not.toHaveBeenCalled();
		expect(p.onclose).not.toHaveBeenCalled();
	});

	it('does not rename into it', async () => {
		render(CategoryFormSheet, {
			props: props({ kind: 'edit', id: original.id }, [original, hiddenFrozen])
		});

		await fireEvent.input(await screen.findByLabelText('Name'), {
			target: { value: 'Tiefkühl' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		expect(await screen.findByRole('alert')).toBeDefined();
		expect(editCategory).not.toHaveBeenCalled();
	});

	it('still lets a category change its own spelling', async () => {
		render(CategoryFormSheet, { props: props({ kind: 'edit', id: original.id }, [original]) });

		await fireEvent.input(await screen.findByLabelText('Name'), {
			target: { value: 'MOLKEREI' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(() => expect(editCategory).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

describe('CategoryFormSheet — a co-member edit to the open category', () => {
	it('keeps what the user typed, and saves it over the live row', async () => {
		const open: CategoryFormTarget = { kind: 'edit', id: original.id };
		const { rerender } = render(CategoryFormSheet, { props: props(open, [original]) });

		const nameInput = await screen.findByLabelText<HTMLInputElement>('Name');
		expect(nameInput.value).toBe('Molkerei');
		await fireEvent.input(nameInput, { target: { value: 'Milchregal' } });

		// The live query delivers the co-member's rename while the sheet is open.
		await rerender(props(open, [renamed]));

		expect(nameInput.value).toBe('Milchregal');
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(() => expect(editCategory).toHaveBeenCalledTimes(1));
		const [target, changes] = vi.mocked(editCategory).mock.calls[0];
		// The save target is the refreshed row, not the one the form opened on.
		expect(target).toBe(renamed);
		// The typed name only: the icon as seeded would undo the co-member's 🧀.
		expect(changes).toEqual({ name: 'Milchregal' });
	});

	it("keeps a co-member's rename when the user changes only the colour", async () => {
		const open: CategoryFormTarget = { kind: 'edit', id: original.id };
		const { rerender } = render(CategoryFormSheet, { props: props(open, [original]) });
		await screen.findByLabelText<HTMLInputElement>('Name');

		await rerender(props(open, [renamed]));
		await fireEvent.click(screen.getByRole('radio', { name: 'Grün' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

		await waitFor(() => expect(editCategory).toHaveBeenCalledTimes(1));
		expect(vi.mocked(editCategory).mock.calls[0][1]).toEqual({ color: 'green' });
	});

	it('seeds a fresh opening from the live row', async () => {
		const open: CategoryFormTarget = { kind: 'edit', id: original.id };
		const { rerender } = render(CategoryFormSheet, { props: props(open, [original]) });
		expect((await screen.findByLabelText<HTMLInputElement>('Name')).value).toBe('Molkerei');

		await rerender(props(null, [renamed]));
		await rerender(props({ kind: 'edit', id: original.id }, [renamed]));

		await waitFor(() =>
			expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Käsetheke')
		);
	});
});

// [D-319] The chosen tile carries a tick, so the choice does not rest on
// telling its green edge from the plates' colours; the colour swatches wear
// the same mark ([D-332]).
describe('CategoryFormSheet — the emoji and colour pickers', () => {
	const tiles = (grid: string) =>
		screen.getAllByRole('radio').filter((r) => r.closest(`[data-testid="${grid}"]`));
	const ticked = (grid: string) => tiles(grid).filter((r) => r.querySelector('.lucide-check'));

	it.each(['emoji-grid', 'color-grid'])(
		'%s ticks the chosen tile alone, and moves the tick with the choice',
		async (grid) => {
			render(CategoryFormSheet, { props: props({ kind: 'edit', id: original.id }, [original]) });
			await screen.findByLabelText<HTMLInputElement>('Name');

			const chosen = ticked(grid);
			expect(chosen).toHaveLength(1);
			expect(chosen[0].getAttribute('aria-checked')).toBe('true');

			const other = tiles(grid).find((r) => r !== chosen[0])!;
			await fireEvent.click(other);
			await waitFor(() => expect(ticked(grid)).toEqual([other]));
		}
	);
});
