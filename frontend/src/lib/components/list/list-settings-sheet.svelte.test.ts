// ListSettingsSheet — the ⋮ inside a list ([D-270]): the list's actions in
// their order, leaving last, under the list's own name ([D-271]). The actions' own flows are the home suite's; this pins
// that the two menus stay one.
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});

vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	const store = writable(true);
	return { online: store, isOnline: () => true };
});

vi.mock('#lib/actions/lists.js', () => ({
	renameList: vi.fn(),
	leaveList: vi.fn(),
	cloneList: vi.fn(),
	exportList: vi.fn().mockResolvedValue(false),
	clearHistory: vi.fn()
}));

import { goto } from '$app/navigation';
import { t } from '#lib/i18n/index.js';
import { online as onlineStore } from '#lib/state/online.js';
import { resetDb } from '#lib/test-kit/db.js';
import { LEAVE_ACTION, LIST_ACTIONS } from './list-actions.svelte';
import WithListActions from '#lib/test-kit/WithListActions.svelte';
import ListSettingsSheet from './ListSettingsSheet.svelte';

const online = onlineStore as unknown as { set(value: boolean): void };

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	online.set(true);
});

const props = { listId: 'list-a', name: 'Familie', open: true, onclose: vi.fn() };

/** The sheet's buttons by their text, the density control's radios aside. */
/** The rows' names, in order: a row's button is laid over it and named by
 *  its label (SettingsRow). */
function buttonLabels(): string[] {
	return screen
		.getAllByRole('button')
		.filter((b) => b.hasAttribute('aria-labelledby'))
		.map((b) =>
			b
				.getAttribute('aria-labelledby')!
				.split(' ')
				.map((id) => document.getElementById(id)?.textContent?.trim())
				.join(' ')
		);
}

describe('ListSettingsSheet ([D-270])', () => {
	it("offers the home card's actions in their order, leaving last", async () => {
		render(WithListActions, { props: { component: ListSettingsSheet, props } });
		await screen.findByRole('button', { name: t('categories_edit') });

		expect(buttonLabels()).toEqual(LIST_ACTIONS.map((a) => t(a.label)));
		expect(LIST_ACTIONS.at(-1)).toBe(LEAVE_ACTION);
	});

	// The ⚙ means app settings everywhere, and lives on the home alone.
	it("is titled with the list's name, and has no way to app settings", async () => {
		render(WithListActions, { props: { component: ListSettingsSheet, props } });

		expect(await screen.findByRole('dialog', { name: 'Familie' })).toBeDefined();
		expect(screen.queryByRole('button', { name: /Einstellungen/ })).toBeNull();
	});

	it('greys out what needs the server while offline', async () => {
		online.set(false);
		render(WithListActions, { props: { component: ListSettingsSheet, props } });

		for (const action of LIST_ACTIONS) {
			const button = await screen.findByRole<HTMLButtonElement>('button', {
				name: t(action.label)
			});
			expect(button.disabled).toBe(action.online);
		}
	});

	it('duplicates from inside the list, with the prefilled name', async () => {
		render(WithListActions, { props: { component: ListSettingsSheet, props } });

		await fireEvent.click(await screen.findByRole('button', { name: t('home_action_duplicate') }));

		const dialog = await screen.findByRole('dialog', { name: 'Liste duplizieren' });
		expect(dialog.querySelector<HTMLInputElement>('input')?.value).toBe('Familie (Kopie)');
	});

	it("opens this list's categories", async () => {
		render(WithListActions, { props: { component: ListSettingsSheet, props } });

		await fireEvent.click(await screen.findByRole('button', { name: t('categories_edit') }));

		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/list/list-a/categories', expect.anything())
		);
	});
});
