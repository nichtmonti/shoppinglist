// The in-list shell's list lifecycle: rename and leave from the ⋮ settings
// sheet (§9.1). Both are online-only server writes: they are gated on
// connectivity, and a rejected rename or leave renders in the sheet the user
// is still looking at instead of closing it with the name silently unchanged.
//
// This is the first route-level component test in the repo: `+layout.svelte`
// takes its list id from `$app/state`'s page store and renders `children`, so
// both are supplied here. Everything below the route (SSE mount, roster
// refresh, the actions themselves) is mocked — this file is responsible for the
// shell's own behaviour, not theirs.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});

vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

// SSE and the roster cache are the layout's side effects, not its subject.
vi.mock('#lib/sync/mount.js', () => ({ setActiveList: vi.fn().mockResolvedValue(undefined) }));
vi.mock('#lib/sync/roster.js', () => ({ refreshRoster: vi.fn().mockResolvedValue(undefined) }));

vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	const store = writable(true);
	return { online: store, isOnline: () => true };
});

vi.mock('#lib/actions/invites.js', () => ({
	activeInvite: vi.fn(() => new Promise(() => {})),
	resetInvite: vi.fn(),
	inviteUrl: (token: string) => `https://example.test/join#${token}`
}));

vi.mock('#lib/actions/lists.js', () => ({
	renameList: vi.fn().mockResolvedValue(undefined),
	leaveList: vi.fn().mockResolvedValue(undefined)
}));

import { db } from '#lib/db.js';
import { resetDb, putMyList } from '#lib/test-kit/db.js';
import { online as onlineStore } from '#lib/state/online.js';
import { historySort, uiDensity, itemSort, listView } from '#lib/state/prefs.js';
import { leaveList, renameList } from '#lib/actions/lists.js';
import { page } from '$app/state';
import { goto } from '$app/navigation';
import * as appState from '#lib/test-kit/app-state.svelte.js';
import { subScreen } from '#lib/components/common/sub-screen.svelte.js';
import Layout from './+layout.svelte';

const online = onlineStore as unknown as { set(value: boolean): void };

// `children` is a required prop of the layout; the shell renders it inside the
// `known` branch, so it only has to be a placeholder.
const children = createRawSnippet(() => ({ render: () => '<div data-testid="page"></div>' }));

async function renderLayout(): Promise<void> {
	await putMyList('list-a', 'Familie', { updated: '2026-01-01T00:00:00.000Z' });
	render(Layout, { props: { children } });
	// Wait for the membership liveQuery, not merely for the shell: the title,
	// the rename seed and the leave confirmation all read the list's name, and
	// the chrome renders before that store has caught up.
	// On the list the name is the sr-only h1 and the switcher's button; on a
	// sub-screen it is the line under the screen's title ([D-323]).
	await waitFor(() => expect(screen.getAllByText('Familie').length).toBeGreaterThan(0));
	await screen.findByTestId('page');
}

async function openSettings(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Aktionen für Familie' }));
}

beforeEach(async () => {
	await resetDb();
	// $app/state is the test kit's (test-kit/component-setup.ts).
	appState.page.params = { id: 'list-a' };
	appState.page.route = { id: '/list/[id]' };
	online.set(true);
	vi.clearAllMocks();
});

describe('in-list rename', () => {
	it('renames from the settings sheet, seeded with the current name', async () => {
		await renderLayout();
		await openSettings();
		await fireEvent.click(await screen.findByRole('button', { name: 'Umbenennen' }));

		const dialog = await screen.findByRole('dialog', { name: 'Umbenennen' });
		const input = within(dialog).getByLabelText<HTMLInputElement>('Name');
		expect(input.value).toBe('Familie');

		await fireEvent.input(input, { target: { value: 'Zuhause' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

		await waitFor(() => expect(vi.mocked(renameList)).toHaveBeenCalledWith('list-a', 'Zuhause'));
	});

	// [D-08]: the title is the list's one name, read from its list row — a
	// co-member's rename lands there with a cycle, and the open list follows.
	it('shows a rename that arrives from a co-member', async () => {
		await renderLayout();

		await db.lists.update('list-a', { name: 'Großfamilie' });

		expect(await screen.findByRole('heading', { level: 1, name: 'Großfamilie' })).toBeDefined();
		expect(screen.getByRole('button', { name: 'Großfamilie' })).toBeDefined();
	});

	it('keeps the dialog open and reports a failed rename', async () => {
		vi.mocked(renameList).mockRejectedValueOnce(new Error('server said no'));
		await renderLayout();
		await openSettings();
		await fireEvent.click(await screen.findByRole('button', { name: 'Umbenennen' }));

		const dialog = await screen.findByRole('dialog', { name: 'Umbenennen' });
		await fireEvent.input(within(dialog).getByLabelText('Name'), {
			target: { value: 'Zuhause' }
		});
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

		// The rejection is reported in the sheet, not lost as an unhandled promise.
		expect(await within(dialog).findByRole('alert')).toBeDefined();
		expect(screen.getByRole('dialog', { name: 'Umbenennen' })).toBeDefined();
	});
});

describe('in-list leave', () => {
	it('leaves only after the confirmation is accepted', async () => {
		await renderLayout();
		await openSettings();
		await fireEvent.click(await screen.findByRole('button', { name: 'Liste verlassen' }));

		const dialog = await screen.findByRole('alertdialog', { name: 'Liste verlassen' });
		expect(within(dialog).getByText('„Familie“ wirklich verlassen?')).toBeDefined();
		expect(vi.mocked(leaveList)).not.toHaveBeenCalled();

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Liste verlassen' }));
		await waitFor(() => expect(vi.mocked(leaveList)).toHaveBeenCalledWith('list-a'));
	});

	it('keeps the dialog open and reports a failed leave', async () => {
		vi.mocked(leaveList).mockRejectedValueOnce(new Error('server said no'));
		await renderLayout();
		await openSettings();
		await fireEvent.click(await screen.findByRole('button', { name: 'Liste verlassen' }));

		const dialog = await screen.findByRole('alertdialog', { name: 'Liste verlassen' });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Liste verlassen' }));

		expect(await within(dialog).findByRole('alert')).toBeDefined();
	});
});

// [D-230] The system back and the app bar's ‹ agree: back closes what is open
// before it leaves the list, and ‹ goes BACK to the home it came from instead
// of stacking a second home on top of the list.
describe('in-list back', () => {
	async function openedFromHome(): Promise<void> {
		appState.resetHistory('/');
		await appState.goto('/list/list-a', { state: { from: '/' } });
		await renderLayout();
	}

	it('closes the settings sheet on the system back and stays on the list', async () => {
		await openedFromHome();
		await openSettings();
		await screen.findByRole('dialog');
		await waitFor(() => expect(appState.page.state.overlays).toHaveLength(1));

		appState.historyBack();

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(appState.historyEntries().index).toBe(1);
		expect(appState.page.url.pathname).toBe('/list/list-a');
	});

	// The sheet closes as the dialog opens: its entry must come off before the
	// dialog's goes on, or back would land on a sheet that is no longer there.
	it('gives a dialog opened from the sheet the sheet’s place, so one back closes it', async () => {
		await openedFromHome();
		await openSettings();
		await fireEvent.click(await screen.findByRole('button', { name: 'Umbenennen' }));
		await screen.findByRole('dialog', { name: 'Umbenennen' });
		await waitFor(() => {
			expect(appState.page.state.overlays).toHaveLength(1);
			expect(appState.historyEntries().index).toBe(2);
		});

		appState.historyBack();

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(appState.page.url.pathname).toBe('/list/list-a');
		expect(appState.page.state.overlays).toBeUndefined();
	});

	it('goes back to the home it came from on ‹', async () => {
		await openedFromHome();

		await fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));

		await waitFor(() => expect(appState.historyEntries().index).toBe(0));
		expect(vi.mocked(goto)).not.toHaveBeenCalled();
	});

	// [D-304] One ‹ per screen: on a sub-screen it is the way back to the list.
	it('goes back to the list from a sub-screen on ‹', async () => {
		appState.resetHistory('/list/list-a');
		await appState.goto('/list/list-a/categories', { state: { from: '/list/list-a' } });
		(page as unknown as { route: { id: string } }).route.id = '/list/[id]/categories';
		await renderLayout();

		await fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));

		await waitFor(() => expect(appState.historyEntries().index).toBe(0));
		expect(vi.mocked(goto)).not.toHaveBeenCalled();
	});

	it("takes a sub-screen's own step back when it has one", async () => {
		(page as unknown as { route: { id: string } }).route.id = '/list/[id]/import';
		const step = vi.fn();
		subScreen.step = step;
		await renderLayout();

		await fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));

		expect(step).toHaveBeenCalledOnce();
		expect(vi.mocked(goto)).not.toHaveBeenCalled();
		subScreen.step = undefined;
	});

	it('goes back to the home after leaving the list, rather than over it', async () => {
		await openedFromHome();
		await openSettings();
		await fireEvent.click(await screen.findByRole('button', { name: 'Liste verlassen' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Liste verlassen' });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Liste verlassen' }));

		await waitFor(() => expect(appState.historyEntries().index).toBe(0));
		expect(appState.page.url.pathname).toBe('/');
		expect(vi.mocked(goto)).not.toHaveBeenCalled();
	});
});

describe('in-list lifecycle offline gating', () => {
	it('disables rename and leave while offline', async () => {
		await renderLayout();
		online.set(false);
		await openSettings();

		const rename = await screen.findByRole('button', { name: 'Umbenennen' });
		const leave = screen.getByRole('button', { name: 'Liste verlassen' });
		// Both are online-only transactional server routes (§7.5/§7.6) — they are
		// not outbox operations and cannot be queued.
		expect(rename).toHaveProperty('disabled', true);
		expect(leave).toHaveProperty('disabled', true);
	});
});

describe('in-list shop-grid density', () => {
	// [D-271] While shopping, the sort menu sets the tiles' density too, under
	// its own heading, so the bar keeps its three icons. The pref itself is the
	// device-local `meta.ui_density` ([D-83]).
	const density = () => {
		let current: string | undefined;
		uiDensity.subscribe((v) => (current = v))();
		return current;
	};

	it('offers the three densities in the sort menu, comfortable chosen', async () => {
		await renderLayout();
		await fireEvent.click(await screen.findByTestId('item-sort'));

		// Two choices, each under its heading.
		expect(await screen.findByText('Sortierung')).toBeDefined();
		expect(screen.getByText('Anzeige')).toBeDefined();
		const group = await screen.findByRole('group', { name: 'Anzeige' });
		expect(
			within(group)
				.getAllByRole('menuitemradio')
				.map((r) => [r.textContent?.trim(), r.getAttribute('aria-checked')])
		).toEqual([
			['Bequem', 'true'],
			['Kompakt', 'false'],
			['Liste', 'false']
		]);
	});

	it('writes the chosen density through the real uiDensity pref', async () => {
		await renderLayout();
		await fireEvent.click(await screen.findByTestId('item-sort'));
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Liste' }));

		await waitFor(() => expect(density()).toBe('list'));
	});

	it('is not offered while editing, where there are no tiles', async () => {
		await listView.set('list');
		await renderLayout();
		await fireEvent.click(await screen.findByTestId('item-sort'));

		await screen.findByRole('menuitemradio', { name: 'A–Z' });
		expect(screen.queryByRole('menuitemradio', { name: 'Kompakt' })).toBeNull();
		// One choice needs no heading.
		expect(screen.queryByText('Sortierung')).toBeNull();
	});
});

// [D-115]: one persisted choice, available before adding anything and shared
// across shop/edit. The ordering itself is covered by the two view suites.
describe('shared item order', () => {
	it('starts both views by category until an order is explicitly selected ([D-115])', async () => {
		await renderLayout();
		await waitFor(() =>
			expect(screen.getByTestId('item-sort').getAttribute('aria-label')).toContain('Kategorie')
		);
		await fireEvent.click(screen.getByTestId('view-toggle-list'));
		await waitFor(() =>
			expect(screen.getByTestId('view-toggle-list').getAttribute('aria-checked')).toBe('true')
		);
		expect(screen.getByTestId('item-sort').getAttribute('aria-label')).toContain('Kategorie');
		expect(await db.meta.get('list_row_sort')).toBeUndefined();
	});

	it('keeps the sort control in the header in both views and persists its selection offline', async () => {
		await renderLayout();
		online.set(false);
		const trigger = screen.getByTestId('item-sort');
		expect(trigger.closest('header')).not.toBeNull();
		await waitFor(() => expect(trigger.getAttribute('aria-label')).toContain('Kategorie'));
		await fireEvent.click(trigger);
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: 'A–Z' }));
		await waitFor(async () => {
			expect((await db.meta.get('list_row_sort'))?.value).toBe('az');
			expect(trigger.getAttribute('aria-label')).toContain('A–Z');
		});

		await fireEvent.click(screen.getByTestId('view-toggle-list'));
		await waitFor(() =>
			expect(screen.getByTestId('view-toggle-list').getAttribute('aria-checked')).toBe('true')
		);
		expect(screen.getByTestId('item-sort')).toBe(trigger);
		await fireEvent.click(trigger);
		const alphabetical = await screen.findByRole('menuitemradio', { name: 'A–Z' });
		expect(alphabetical.getAttribute('aria-checked')).toBe('true');
		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kategorie' }));
		await waitFor(() => expect(trigger.getAttribute('aria-label')).toContain('Kategorie'));
		await fireEvent.click(screen.getByTestId('view-toggle-shop'));
		await waitFor(() =>
			expect(screen.getByTestId('view-toggle-shop').getAttribute('aria-checked')).toBe('true')
		);
		await waitFor(() => expect(trigger.getAttribute('aria-label')).toContain('Kategorie'));
	});

	it('honours the previously saved editing order', async () => {
		await itemSort.set('az');
		await renderLayout();
		await waitFor(() =>
			expect(screen.getByTestId('item-sort').getAttribute('aria-label')).toContain('A–Z')
		);
	});

	it('reuses the header menu with the independent history order on the previous-items route', async () => {
		(page as unknown as { route: { id: string } }).route.id = '/list/[id]/previous';
		await historySort.set('recent');
		await itemSort.set('category');
		await renderLayout();

		const trigger = screen.getByTestId('item-sort');
		await waitFor(() => expect(trigger.getAttribute('aria-label')).toContain('Zuletzt gekauft'));
		await fireEvent.click(trigger);
		expect(screen.getByRole('menuitemradio', { name: 'Zuletzt gekauft' })).toBeTruthy();
	});
});

// [D-323] A sub-screen titles the bar with its own name, the list's under it;
// the view switch and ⋮ belong to the list page.
describe('a sub-screen in the bar', () => {
	it('shows its title as the h1 with the list name under it, and no view switch or ⋮', async () => {
		(page as unknown as { route: { id: string } }).route.id = '/list/[id]/categories';
		subScreen.title = 'Kategorien bearbeiten';
		await renderLayout();

		expect(screen.getByRole('heading', { level: 1, name: 'Kategorien bearbeiten' })).toBeDefined();
		expect(screen.getByText('Familie')).toBeDefined();
		expect(screen.queryByTestId('view-toggle-shop')).toBeNull();
		expect(screen.queryByTestId('list-menu')).toBeNull();
		expect(screen.queryByTestId('item-sort')).toBeNull();
		subScreen.title = undefined;
	});

	it('still only flips the pref on the list page itself', async () => {
		await renderLayout();

		await fireEvent.click(screen.getByTestId('view-toggle-list'));

		await waitFor(async () => expect((await db.meta.get('list_view'))?.value).toBe('list'));
		// Switching views is not a navigation (§9.1: one page, two surfaces) —
		// Back belongs to "return to the home".
		expect(vi.mocked(goto)).not.toHaveBeenCalled();
	});
});

// [D-272] The app bar's actions are sort and ⋮ in BOTH views, the pair the
// home's bar has too (sort, ⚙), so neither moves between screens or views.
describe('app-bar action order', () => {
	it("keeps sort and ⋮ as the bar's only actions in both views", async () => {
		await renderLayout();

		const sort = screen.getByTestId('item-sort');
		const menu = screen.getByRole('button', { name: 'Aktionen für Familie' });
		const actions = () => Array.from((menu.parentElement as HTMLElement).children);
		expect(actions()).toEqual([sort, menu]);

		await fireEvent.click(screen.getByTestId('view-toggle-list'));
		await waitFor(async () => expect((await db.meta.get('list_view'))?.value).toBe('list'));
		expect(actions()).toEqual([sort, menu]);
	});
});

// [D-185]: "Diese Liste gibt es nicht (mehr)." rendered for a frame on every
// load (before IndexedDB answered) and, after a fresh sign-in, until the first
// digest landed — in place of a list the user has.
describe('an unknown list', () => {
	const notFound =
		'Diese Liste ist nicht in deinen Listen. Vielleicht wurde sie gelöscht, oder du bist kein Mitglied: Dann brauchst du einen Einladungslink.';

	it('says nothing until the membership set has been pulled, then says it is gone', async () => {
		await putMyList('list-other', 'Andere');
		render(Layout, { props: { children } });
		// The memberships are read (another list is there) but never pulled.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.queryByText(notFound)).toBeNull();
		expect(screen.queryByText('nur du')).toBeNull();

		await db.meta.put({ key: 'memberships_synced_at', value: '2026-01-01T00:00:00.000Z' });
		expect(await screen.findByText(notFound)).toBeDefined();
		// [D-293] Its actions would act on a list that is not this account's.
		expect(screen.queryByTestId('list-menu')).toBeNull();
	});

	it('never shows the notice for a list that is there', async () => {
		await db.meta.put({ key: 'memberships_synced_at', value: '2026-01-01T00:00:00.000Z' });
		await renderLayout();
		expect(screen.getByTestId('page')).toBeDefined();
		expect(screen.queryByText(notFound)).toBeNull();
	});
});

// [D-296] The line under the name says who is on the list; a tap on it shows
// them, as ⋮ → „Teilen & Mitglieder“ does. The name keeps the quick switcher.
describe('the line under the name', () => {
	it('opens the members', async () => {
		await renderLayout();

		await fireEvent.click(await screen.findByTestId('members-line'));
		expect(await screen.findByRole('dialog', { name: 'Teilen & Mitglieder' })).toBeDefined();
	});
});
