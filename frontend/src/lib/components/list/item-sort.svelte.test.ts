import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '#lib/db.js';
import { resetDb } from '#lib/test-kit/db.js';
import { historySort, itemSort, uiDensity } from '#lib/state/prefs.js';
import ItemSort from './ItemSort.svelte';

beforeEach(async () => {
	await resetDb();
	await itemSort.set('category');
	await historySort.set('recent');
	await uiDensity.set('comfortable');
});

describe('ItemSort — previous items', () => {
	it('reuses the item-order menu with last purchased as the default', async () => {
		render(ItemSort, { props: { history: true } });

		const trigger = screen.getByTestId('item-sort');
		await waitFor(() => expect(trigger.getAttribute('aria-label')).toContain('Zuletzt gekauft'));
		await fireEvent.click(trigger);

		const recent = screen.getByRole('menuitemradio', { name: 'Zuletzt gekauft' });
		expect(recent).toBeTruthy();
		expect(screen.getByRole('menuitemradio', { name: 'A–Z' })).toBeTruthy();
		expect(screen.getByRole('menuitemradio', { name: 'Kategorie' })).toBeTruthy();
		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull());
	});

	it('persists history ordering without changing the active-list order', async () => {
		render(ItemSort, { props: { history: true } });

		await fireEvent.click(screen.getByTestId('item-sort'));
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: 'A–Z' }));

		await waitFor(async () => {
			expect((await db.meta.get('history_sort'))?.value).toBe('az');
			expect((await db.meta.get('list_row_sort'))?.value).toBe('category');
		});
	});
});

describe('ItemSort — the shop density', () => {
	async function choose(name: string): Promise<void> {
		await fireEvent.click(screen.getByTestId('item-sort'));
		await fireEvent.click(await screen.findByRole('menuitemradio', { name }));
	}

	it('switches to aisle order when „Liste“ is chosen, and keeps a later A–Z', async () => {
		await itemSort.set('az');
		render(ItemSort, { props: { density: true } });

		await choose('Liste');
		await waitFor(async () => {
			expect((await db.meta.get('ui_density'))?.value).toBe('list');
			expect((await db.meta.get('list_row_sort'))?.value).toBe('category');
		});

		await choose('A–Z');
		await waitFor(async () => expect((await db.meta.get('list_row_sort'))?.value).toBe('az'));
	});

	it('leaves the order alone for the grid densities', async () => {
		await itemSort.set('az');
		render(ItemSort, { props: { density: true } });

		await choose('Kompakt');
		await waitFor(async () => expect((await db.meta.get('ui_density'))?.value).toBe('compact'));
		expect((await db.meta.get('list_row_sort'))?.value).toBe('az');
	});
});
