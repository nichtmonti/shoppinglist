// The list route's page renders one list's view. Switching lists through the
// ▾ switcher keeps the route mounted, so the page must not carry anything
// typed on one list over to the next.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-kit/app-state.svelte.js'));

import { page } from '$app/state';
import { listView } from '#lib/state/prefs.js';
import { invalidateLiveCaches } from '#lib/state/live.js';
import { resetDb, seedList } from '#lib/test-kit/db.js';
import { t } from '#lib/i18n/index.js';
import Page from './+page.svelte';

beforeEach(async () => {
	await resetDb();
	await seedList({ listId: 'list-a' });
	await seedList({ listId: 'list-b' });
	await listView.set('list');
	page.params = { id: 'list-a' };
});

describe('list page', () => {
	it('starts the next list with an empty add bar', async () => {
		render(Page);
		const input = await screen.findByRole<HTMLInputElement>('combobox', { name: t('add_label') });
		await fireEvent.input(input, { target: { value: 'Milch' } });
		expect(input.value).toBe('Milch');

		page.params = { id: 'list-b' };
		flushSync();

		await waitFor(() =>
			expect(screen.getByRole<HTMLInputElement>('combobox', { name: t('add_label') }).value).toBe(
				''
			)
		);
	});

	// [D-196] The view pref answers asynchronously and falls back to 'shop', so
	// a device set to the list view painted the shop view first on a cold open.
	it('renders no view before the saved one is known', async () => {
		// Nothing reads the pref now, so it restarts from its fallback: a cold start.
		invalidateLiveCaches();
		const { container } = render(Page);

		// The very first render: a cold pref store has not answered yet.
		expect(container.querySelector('.shop-view')).toBeNull();
		await screen.findByRole('combobox', { name: t('add_label') });
		expect(container.querySelector('.shop-view')).toBeNull();
	});
});
