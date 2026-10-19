// §9.3's ▾ quick-switcher as a bottom Sheet ([D-83]): every membership
// is listed (the current one marked), and selecting one navigates. Follows the
// harness pattern documented in share-sheet.svelte.test.ts: mock the modules
// that reach outside happy-dom, seed Dexie (fake-indexeddb) BEFORE render(), then
// await the liveQuery-backed memberships store via waitFor().
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});

// `resolve()` needs no manifest lookups for our purposes — just the
// `[param]` substitution the component relies on.
vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

import { resetDb, putMyList } from '#lib/test-kit/db.js';
import { goto } from '$app/navigation';
import ListSwitcher from './ListSwitcher.svelte';

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
});

describe('ListSwitcher', () => {
	it('opens on trigger click and lists every membership, marking the current one', async () => {
		await putMyList('list-a', 'Familie');
		await putMyList('list-b', 'Wocheneinkauf');

		render(ListSwitcher, { props: { currentListId: 'list-a', listName: 'Familie' } });

		// Closed: no dialog, only the trigger button.
		expect(screen.queryByRole('dialog')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Familie' }));

		const dialog = await screen.findByRole('dialog');
		// Both memberships are listed — including the current one. The rows come from
		// the liveQuery-backed memberships store, whose first emission lands a tick
		// after the sheet mounts — findBy* retries until it does.
		expect(await within(dialog).findByText('Familie')).toBeDefined();
		expect(await within(dialog).findByText('Wocheneinkauf')).toBeDefined();
		// The current list's row says so to assistive tech; the other does not.
		const rowOf = (name: string) => within(dialog).getByText(name).closest('button')!;
		expect(rowOf('Familie').getAttribute('aria-current')).toBe('true');
		expect(rowOf('Wocheneinkauf').hasAttribute('aria-current')).toBe(false);
	});

	// Switching is sideways ([D-230]): the picked list replaces this one in
	// history, so back and ‹ still lead home rather than through every list.
	it('replaces the current list with the selected one on row click', async () => {
		await putMyList('list-a', 'Familie');
		await putMyList('list-b', 'Wocheneinkauf');

		render(ListSwitcher, { props: { currentListId: 'list-a', listName: 'Familie' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Familie' }));
		const dialog = await screen.findByRole('dialog');

		await fireEvent.click(await within(dialog).findByRole('button', { name: /Wocheneinkauf/ }));

		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/list/list-b', {
				replace: true,
				state: {},
				persistState: true
			})
		);
	});

	it('shows the "My lists" row and navigates home', async () => {
		await putMyList('list-a', 'Familie');

		render(ListSwitcher, { props: { currentListId: 'list-a', listName: 'Familie' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Familie' }));
		const dialog = await screen.findByRole('dialog');

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Meine Listen' }));

		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/', {
				replace: true,
				state: {},
				persistState: true
			})
		);
	});

	it('keeps the empty case when the user has exactly one list', async () => {
		await putMyList('list-a', 'Familie');

		render(ListSwitcher, { props: { currentListId: 'list-a', listName: 'Familie' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Familie' }));
		const dialog = await screen.findByRole('dialog');

		// The empty case is store-backed too ($memberships.length === 1), so its
		// first emission lands a tick after the sheet mounts — findBy* retries.
		expect(await within(dialog).findByText('Keine weiteren Listen')).toBeDefined();
		// The "My lists" door home is still there.
		expect(within(dialog).getByRole('button', { name: 'Meine Listen' })).toBeDefined();
	});

	// The layout draws the trigger before the list's name has been read, so the
	// bar keeps its height ([D-185]); until then it must still have a name —
	// axe flagged the nameless button on every sub-route's first frame.
	it('has an accessible name while the list name is still unread', () => {
		render(ListSwitcher, { props: { currentListId: 'list-a', listName: '' } });
		expect(screen.getByRole('button', { name: 'Listen' })).toBeDefined();
	});
});
