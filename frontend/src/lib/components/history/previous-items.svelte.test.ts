// §6.10 "Frühere Artikel" screen — component-harness test in the `client`
// vitest project. Pattern per src/lib/components/auth/auth-screen.svelte.test.ts
// and src/lib/components/home/lists-home.svelte.test.ts: seed Dexie
// (fake-indexeddb) BEFORE render(), then await the liveQuery-backed stores via
// waitFor().
import { subScreen } from '#lib/components/common/sub-screen.svelte.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});
vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

// The clear's server route and its only feedback, the toast ([D-79]).
vi.mock('#lib/actions/lists.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/actions/lists.js')>()),
	clearHistory: vi.fn().mockResolvedValue(3)
}));
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({}, { show: true })
);

import { clearHistory } from '#lib/actions/lists.js';
import { showToast } from '#lib/toasts.js';
import { db } from '#lib/db.js';
import { resetDb, makeCategory, makeItem, seedList, untilLoaded } from '#lib/test-kit/db.js';
import { daysAgo, isoAgo } from '#lib/test-kit/time.js';
import { memberships } from '#lib/state/data.js';
import { historySort } from '#lib/state/prefs.js';
import { t } from '#lib/i18n/index.js';
import WithListActions from '#lib/test-kit/WithListActions.svelte';
import PreviousItems from './PreviousItems.svelte';

/** The screen as the list route mounts it, its ListActions in context. */
const renderPrevious = (listId: string) =>
	render(WithListActions, { props: { component: PreviousItems, props: { listId } } });

// Ticked a minute ago: the list's current trip ([D-18]), so not a previous item.
const thisTrip = () => isoAgo(60_000);
// Yesterday at local noon: a previous trip whatever hour the suite runs at
// (at least twelve hours back, far past the trip gap), and exactly one
// calendar day ago, so the row reads "gestern".
const yesterday = () => {
	const at = new Date();
	at.setDate(at.getDate() - 1);
	at.setHours(12, 0, 0, 0);
	return at.toISOString();
};

beforeEach(async () => {
	await resetDb();
	await historySort.set('recent');
	vi.clearAllMocks();
});

describe('PreviousItems', () => {
	// [D-185]: nothing renders an answer before its data has.
	it('shows no empty state before the items have loaded', async () => {
		await seedList({
			listId: 'list-1',
			items: [
				makeItem({ list: 'list-1', name: 'Spülmittel', checked: true, checked_at: daysAgo(8) })
			]
		});

		const { container } = renderPrevious('list-1');
		expect(screen.queryByText(t('history_empty'))).toBeNull();

		await waitFor(() =>
			expect(container.querySelector('.pi-name')?.textContent).toBe('Spülmittel')
		);
	});

	// [D-200] The note comes back on a re-add from here, so the row shows it —
	// and announces it; the last trip's quantity does neither.
	it('shows a row’s note but not its quantity', async () => {
		await seedList({
			listId: 'list-1',
			items: [
				makeItem({
					list: 'list-1',
					name: 'Milch',
					quantity: '2 l',
					note: 'bio',
					checked: true,
					checked_at: daysAgo(8)
				})
			]
		});

		const { container } = renderPrevious('list-1');

		await waitFor(() => expect(container.querySelector('.pi-note')?.textContent).toBe('bio'));
		expect(container.textContent).not.toContain('2 l');
		const row = screen.getByTestId('prev-item');
		expect(row.getAttribute('aria-describedby')).toBe(container.querySelector('.pi-note')?.id);
	});

	it("shows items checked before the current trip, newest first, excluding the trip's", async () => {
		await seedList({
			listId: 'list-1',
			items: [
				makeItem({ list: 'list-1', name: 'Spülmittel', checked: true, checked_at: daysAgo(8) }),
				makeItem({ list: 'list-1', name: 'Schokolade', checked: true, checked_at: daysAgo(20) }),
				makeItem({ list: 'list-1', name: 'Milch', checked: true, checked_at: thisTrip() })
			]
		});

		const { container } = renderPrevious('list-1');

		await waitFor(() => {
			const names = Array.from(container.querySelectorAll('.pi-name')).map((el) => el.textContent);
			expect(names).toEqual(['Spülmittel', 'Schokolade']);
		});
		expect(container.textContent).not.toContain('Milch');
	});

	it('sorts previous items A–Z when that history order is selected', async () => {
		await historySort.set('az');
		await seedList({
			listId: 'list-az',
			items: [
				makeItem({
					list: 'list-az',
					name: 'Zitrone',
					checked: true,
					checked_at: yesterday(),
					last_bought_at: yesterday()
				}),
				makeItem({
					list: 'list-az',
					name: 'Apfel',
					checked: true,
					checked_at: daysAgo(8),
					last_bought_at: daysAgo(8)
				})
			]
		});

		const { container } = renderPrevious('list-az');

		await waitFor(() => {
			const names = Array.from(container.querySelectorAll('.pi-name')).map((el) => el.textContent);
			expect(names).toEqual(['Apfel', 'Zitrone']);
		});
	});

	it('groups previous items in the list’s category order', async () => {
		await historySort.set('category');
		const produce = makeCategory({
			id: 'produce',
			list: 'list-categories',
			name: 'Obst & Gemüse',
			sort_order: 1
		});
		const dairy = makeCategory({
			id: 'dairy',
			list: 'list-categories',
			name: 'Molkerei',
			sort_order: 2
		});
		await seedList({
			listId: 'list-categories',
			categories: [dairy, produce],
			items: [
				makeItem({
					list: 'list-categories',
					name: 'Milch',
					category_key: dairy.id,
					checked: true,
					checked_at: yesterday(),
					last_bought_at: yesterday()
				}),
				makeItem({
					list: 'list-categories',
					name: 'Banane',
					category_key: produce.id,
					checked: true,
					checked_at: daysAgo(8),
					last_bought_at: daysAgo(8)
				})
			]
		});

		const { container } = renderPrevious('list-categories');

		await waitFor(() => {
			const headings = Array.from(container.querySelectorAll('.cat-head-name')).map(
				(el) => el.textContent
			);
			expect(headings).toEqual(['Obst & Gemüse', 'Molkerei']);
			const names = Array.from(container.querySelectorAll('.pi-name')).map((el) => el.textContent);
			expect(names).toEqual(['Banane', 'Milch']);
		});
	});

	it('dates each row in calendar days, in the name AND the accessible label', async () => {
		// [D-18]: this screen is sorted by the purchase, so it shows it. The date
		// rides the aria-label too — the
		// label overrides content for the accessible name, so a date only in the
		// span would be silently dropped for a screen reader.
		await seedList({
			listId: 'list-1',
			items: [
				makeItem({
					list: 'list-1',
					name: 'Spülmittel',
					checked: true,
					checked_at: yesterday(),
					last_bought_at: yesterday()
				})
			]
		});

		const { container } = renderPrevious('list-1');

		await waitFor(() => {
			expect(container.querySelector('.pi-when')?.textContent?.trim()).toBe('gestern');
		});
		expect(
			screen.getByRole('button', { name: '„Spülmittel“ wieder auf die Liste, zuletzt gestern' })
		).toBeTruthy();
	});

	it('shows no date, and the plain label, once the stamps have been cleared', async () => {
		// [D-79] leaves a checked row here with both stamps null. Rendering "heute"
		// for it would invent a purchase date that was just explicitly erased.
		await seedList({
			listId: 'list-2',
			items: [
				makeItem({
					list: 'list-2',
					name: 'Spülmittel',
					checked: true,
					checked_at: null,
					last_bought_at: null
				})
			]
		});

		const { container } = renderPrevious('list-2');

		await waitFor(() => expect(container.querySelector('.pi-name')).not.toBeNull());
		expect(container.querySelector('.pi-when')).toBeNull();
		expect(screen.getByRole('button', { name: '„Spülmittel“ wieder auf die Liste' })).toBeTruthy();
	});

	it('shows a row that was bought and then REMOVED from the list', async () => {
		// Re-added from this screen, then removed because it turned out not to be
		// wanted. §6.10 keeps no separate history record, so the tombstone must
		// not take the purchase with it — nor out of the add bar's learned
		// suggestions.
		await seedList({
			listId: 'list-1',
			items: [
				makeItem({ list: 'list-1', name: 'Spülmittel', checked: true, checked_at: daysAgo(8) }),
				makeItem({
					list: 'list-1',
					name: 'Haselnussmus',
					checked: false,
					checked_at: null,
					last_bought_at: daysAgo(2),
					deleted_at: daysAgo(0)
				}),
				// Never bought, just removed — genuinely gone, and must stay gone.
				makeItem({ list: 'list-1', name: 'Servietten', deleted_at: daysAgo(0) })
			]
		});

		const { container } = renderPrevious('list-1');

		await waitFor(() => {
			const names = Array.from(container.querySelectorAll('.pi-name')).map((el) => el.textContent);
			expect(names).toEqual(['Haselnussmus', 'Spülmittel']);
		});
		expect(container.textContent).not.toContain('Servietten');
	});

	it('re-adds a removed row on tap: lifts the tombstone, keeps last_bought_at', async () => {
		const bought = daysAgo(2);
		const item = makeItem({
			list: 'list-9',
			name: 'Haselnussmus',
			checked: false,
			checked_at: null,
			last_bought_at: bought,
			deleted_at: daysAgo(0)
		});
		await seedList({ listId: 'list-9', items: [item] });

		renderPrevious('list-9');
		// Regex: this row is dated, so its accessible name carries the date too.
		// The exact wording is the subject of the dating tests above, not of this
		// one, which is about what the tap DOES.
		const row = await screen.findByRole('button', {
			name: /^„Haselnussmus“ wieder auf die Liste, zuletzt /
		});
		await fireEvent.click(row);

		await waitFor(async () => {
			const row = await db.items.get(item.id);
			expect(row?.deleted_at).toBeNull();
			expect(row?.checked).toBe(false);
			expect(row?.last_bought_at).toBe(bought);
		});
	});

	it('names the re-add row for its item — the visible affordance is only a glyph', async () => {
		await seedList({
			listId: 'list-8',
			items: [
				makeItem({
					list: 'list-8',
					name: 'Spülmittel',
					checked: true,
					checked_at: daysAgo(9),
					last_bought_at: daysAgo(9)
				})
			]
		});
		renderPrevious('list-8');

		// Spelling the action out in the row squeezed `.pi-name` on a phone, so
		// the words live in the accessible name now. Losing them entirely would
		// leave the row announcing just the item, with no hint that tapping adds.
		await waitFor(() =>
			expect(
				screen.getByRole('button', { name: /^„Spülmittel“ wieder auf die Liste, zuletzt / })
			).toBeTruthy()
		);
	});

	it('re-adds an item on tap: clears checked/checked_at, keeps last_bought_at', async () => {
		const boughtAt = daysAgo(9);
		const item = makeItem({
			list: 'list-2',
			name: 'Duschgel',
			checked: true,
			checked_at: daysAgo(9),
			last_bought_at: boughtAt
		});
		await seedList({ listId: 'list-2', items: [item] });

		renderPrevious('list-2');

		// The row's accessible name is the full re-add sentence: the visible
		// affordance is only a glyph, so the words live in the aria-label.
		const row = await screen.findByRole('button', {
			name: /^„Duschgel“ wieder auf die Liste, zuletzt /
		});
		await fireEvent.click(row);

		await waitFor(async () => {
			const updated = await db.items.get(item.id);
			expect(updated?.checked).toBe(false);
			expect(updated?.checked_at).toBeNull();
			expect(updated?.last_bought_at).toBe(boughtAt);
		});
	});

	it('shows the empty state when there are no previous items yet', async () => {
		await seedList({ listId: 'list-3', items: [] });

		const { container } = renderPrevious('list-3');

		await waitFor(() => {
			expect(container.querySelector('.emptystate')?.textContent).toContain(
				'Noch keine früheren Artikel'
			);
		});
	});

	// [D-304] The list's app bar ‹ is the one way back.
	it("names itself in the list's app bar, with no back control of its own ([D-323])", async () => {
		await seedList({ listId: 'list-9', items: [] });

		renderPrevious('list-9');

		expect(subScreen.title).toBe('Frühere Artikel');
		expect(screen.queryByRole('button', { name: /Zurück/ })).toBeNull();
	});
});

// [D-79] „Kaufdaten zurücksetzen", at the foot of the screen whose dates it
// forgets ([D-271]).
describe('PreviousItems — clearing the purchase dates', () => {
	async function seedBought(): Promise<void> {
		await seedList({
			listId: 'list-a',
			name: 'Familie',
			items: [makeItem({ list: 'list-a', name: 'Milch', checked: true, checked_at: daysAgo(8) })]
		});
	}

	async function openClearDialog(): Promise<HTMLElement> {
		renderPrevious('list-a');
		// The confirmation names the list from the memberships mirror.
		await untilLoaded(memberships);
		await fireEvent.click(await screen.findByRole('button', { name: 'Kaufdaten zurücksetzen' }));
		return await screen.findByRole('alertdialog', { name: 'Kaufdaten zurücksetzen?' });
	}

	it('is not offered while there is no date to forget', async () => {
		await seedList({ listId: 'list-a', items: [makeItem({ list: 'list-a', name: 'Milch' })] });
		renderPrevious('list-a');

		expect(await screen.findByText(t('history_empty'))).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Kaufdaten zurücksetzen' })).toBeNull();
	});

	it('names the list in the confirmation sheet', async () => {
		await seedBought();

		const dialog = await openClearDialog();
		const body = within(dialog).getByText(/Vergisst, wann in Familie zuletzt gekauft wurde/);
		// The one part that is lost for good, so the sheet must say it ([D-100]).
		expect(body.textContent).toMatch(
			/entfernte Artikel, die die Liste nur von einem Kauf kannte, sind danach vergessen/
		);
		// Destructive, but no item on the list goes: the soft red ([D-332]).
		expect(within(dialog).getByRole('button', { name: 'Zurücksetzen' }).className).toContain(
			'bg-danger-soft'
		);
	});

	it('clears once confirmed and toasts the cleared count', async () => {
		await seedBought();

		const dialog = await openClearDialog();
		// Opening the dialog is not consent.
		expect(vi.mocked(clearHistory)).not.toHaveBeenCalled();

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Zurücksetzen' }));
		await waitFor(() => expect(vi.mocked(clearHistory)).toHaveBeenCalledWith('list-a'));
		await waitFor(() =>
			expect(vi.mocked(showToast)).toHaveBeenCalledWith('Kaufdaten für 3 Artikel zurückgesetzt')
		);
	});

	it('does nothing when the confirmation is cancelled', async () => {
		await seedBought();

		const dialog = await openClearDialog();
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));

		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(vi.mocked(clearHistory)).not.toHaveBeenCalled();
	});
});
