// §14: "the lists-home card counts and the three ordering modes" (§9.3). Component-harness test in the `client` vitest project — see
// src/lib/components/auth/auth-screen.svelte.test.ts for the pattern this
// follows: seed Dexie (fake-indexeddb) BEFORE render(), then await the
// liveQuery-backed stores to catch up via waitFor().
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The router is the test kit's fake history (test-kit/component-setup.ts); goto
// is spied on over it.
vi.mock('$app/navigation', async () => {
	const { navigation } = await import('#lib/test-kit/app-state.svelte.js');
	return { ...navigation, goto: vi.fn(navigation.goto) };
});

// `resolve()` needs no manifest lookups for our purposes — just the
// `[param]` substitution `#lib/actions` and this component rely on.
vi.mock('$app/paths', () => ({
	resolve: (route: string, params?: Record<string, string>) =>
		params ? route.replace(/\[(\w+)\]/g, (_match, key: string) => params[key]) : route
}));

// online is a plain `readable` over `navigator.onLine` — mock it with a
// writable so tests can flip connectivity deterministically.
vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	const store = writable(true);
	return { online: store, isOnline: () => true };
});

// The export's only feedback is its toast, so the suite has to see
// the calls — same spy pattern as the add-bar suite.
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({}, { show: true })
);

// The home's app bar carries the §12.1 sync chip ([D-130]), and #lib/auth
// reaches for IndexedDB and WebAuthn on import — same mock as the banner's own
// suite, so the chip mounts without dragging the real ceremony code in.
vi.mock('#lib/auth/index.js', async () => {
	const { authModuleMock } = await import('#lib/test-kit/auth-mock.js');
	return authModuleMock({}, { nickname: 'Anna', isValid: true });
});

// The destructive path below needs the action stubbed — the real leaveList
// talks to PocketBase and purges Dexie; what this suite is responsible for is
// that the card menu reaches it with the right list id, and only on a
// confirmed intent. #lib/actions/lists.ts's own behaviour is covered in
// src/lib/actions/lists.test.ts.
vi.mock('#lib/actions/lists.js', () => ({
	createList: vi.fn(),
	renameList: vi.fn(),
	leaveList: vi.fn().mockResolvedValue(undefined),
	cloneList: vi.fn(),
	exportList: vi.fn(),
	clearHistory: vi.fn().mockResolvedValue(3)
}));

import { SHADOW_ITEM_MARKER_PROPERTY_NAME, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
import { db, type RosterEntry } from '#lib/db.js';
import { resetDb, makeItem, makeMembership, putMyList, putSynced } from '#lib/test-kit/db.js';
import { listOrder, listSort } from '#lib/state/prefs.js';
import { online as onlineStore } from '#lib/state/online.js';
import { createList, exportList, leaveList, renameList } from '#lib/actions/lists.js';
import { goto } from '$app/navigation';
import { t } from '#lib/i18n/index.js';
import * as appState from '#lib/test-kit/app-state.svelte.js';

import { invalidateLiveCaches } from '#lib/state/live.js';
import { showToast } from '#lib/toasts.js';
import { authState, login } from '#lib/auth/index.js';
import ListsHome from './ListsHome.svelte';
import { HOME_ACTIONS, LIST_ACTIONS } from '#lib/components/list/list-actions.svelte.js';

// The mocked module exports a writable, but the real module's type is
// `Readable<boolean>` — cast to reach `.set()` for the mock only.
const online = onlineStore as unknown as { set(value: boolean): void };

/** Moves a list's activity stamp (the digest's max_updated), keeping its name. */
async function putList(id: string, updated: string): Promise<void> {
	const name = (await db.lists.get(id))?.name ?? '';
	await db.lists.put({ id, name, updated });
}

function roster(list: string, account: string, nickname: string): RosterEntry {
	return { id: `${list}_${account}`, list, account, nickname, joined: '2026-01-01T00:00:00.000Z' };
}

/** The card around a list's open button ([D-83]: the button covers the
 *  card, and the summary it names sits beside it). */
function cardByName(name: string): HTMLElement {
	return screen
		.getByRole('link', { name: `${name} öffnen` })
		.closest<HTMLElement>('[data-slot="card"]')!;
}

// The ordering modes live in the header's sort menu (the same SortMenu the
// in-list bar uses) rather than in a chip row, so selecting one is two clicks:
// open the trigger, pick the radio item.
async function selectSort(name: string): Promise<void> {
	// findBy: the screen renders only once its stores have answered.
	await fireEvent.click(await screen.findByTestId('list-sort'));
	await fireEvent.click(await screen.findByRole('menuitemradio', { name }));
}

beforeEach(async () => {
	await resetDb();
	// listSort/listOrder are module-singleton prefs over Dexie `meta`, and
	// resetDb() recreates the database under them — reassert the defaults so a
	// mode set by an earlier test cannot leak into the next one.
	await listSort.set('activity');
	await listOrder.set([]);
	// Every suite below models a device whose memberships have been pulled; the
	// not-yet-pulled home has its own suite ([D-182]).
	await markPulled();
	online.set(true);
	vi.clearAllMocks();
});

async function markPulled(): Promise<void> {
	await db.meta.put({ key: 'memberships_synced_at', value: '2026-01-01T00:00:00.000Z' });
}

describe('ListsHome card counts', () => {
	it('renders only the remaining count, "alles erledigt ✓", and "leer"', async () => {
		await putMyList('list-mixed', 'Wocheneinkauf');
		await putMyList('list-done', 'Grillfest');
		await putMyList('list-empty', 'Baumarkt');
		await putList('list-mixed', '2026-01-01T00:00:00.000Z');
		await putList('list-done', '2026-01-01T00:00:00.000Z');
		await putList('list-empty', '2026-01-01T00:00:00.000Z');
		await putSynced([
			makeItem({ list: 'list-mixed', name: 'Milch', checked: false }),
			makeItem({ list: 'list-mixed', name: 'Butter', checked: false }),
			makeItem({
				list: 'list-mixed',
				name: 'Brot',
				checked: true,
				checked_at: '2026-01-01T00:00:00.000Z'
			}),
			// a tombstone must not count toward either bucket
			makeItem({
				list: 'list-mixed',
				name: 'Alt',
				checked: true,
				deleted_at: '2026-01-01T00:00:00.000Z'
			}),
			makeItem({
				list: 'list-done',
				name: 'Kohle',
				checked: true,
				checked_at: '2026-01-01T00:00:00.000Z'
			}),
			makeItem({
				list: 'list-done',
				name: 'Wurst',
				checked: true,
				checked_at: '2026-01-01T00:00:00.000Z'
			})
		]);

		render(ListsHome);

		await waitFor(() => {
			expect(within(cardByName('Wocheneinkauf')).getByText('2 offen')).toBeDefined();
			expect(within(cardByName('Grillfest')).getByText('alles erledigt ✓')).toBeDefined();
			expect(within(cardByName('Baumarkt')).getByText('leer')).toBeDefined();
		});
	});
});

// A list left and re-joined on another device leaves this one a second
// membership row for it until the next sync; offline, until it is online.
describe('ListsHome with two memberships for one list', () => {
	it('shows the list once, and the other lists beside it', async () => {
		await putMyList('list-a', 'Wocheneinkauf');
		await db.memberships.put(
			makeMembership({ id: 'stalemember001', list: 'list-a', updated: '2026-01-01T00:00:00.000Z' })
		);
		await putMyList('list-b', 'Baumarkt');

		render(ListsHome);

		await waitFor(() => {
			expect(screen.getAllByRole('link', { name: 'Wocheneinkauf öffnen' })).toHaveLength(1);
			expect(screen.getByRole('link', { name: 'Baumarkt öffnen' })).toBeDefined();
		});
	});
});

// [D-185]: an empty `items` is not "leer" until the cycle has pulled that
// list's items. The cycle writes the list's row with its name first ([D-08])
// and its `updated` only after the pull, so a row without `updated` — the state
// between the two, set up below — is a list not pulled yet.
describe('ListsHome count before the items are pulled', () => {
	it('shows no count until the list is pulled, then the real one', async () => {
		await putMyList('list-new', 'Frisch');
		await db.lists.put({ id: 'list-new', name: 'Frisch' });
		render(ListsHome);
		const card = await waitFor(() => cardByName('Frisch'));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(within(card).queryByText('leer')).toBeNull();

		await putSynced([makeItem({ list: 'list-new', name: 'Milch', checked: false })]);
		await putList('list-new', '2026-01-01T00:00:00.000Z');
		await waitFor(() => expect(within(cardByName('Frisch')).getByText('1 offen')).toBeDefined());
	});
});

// The member count says a list is shared subtly (meta line, faint) and answers
// "with how many?".
describe('ListsHome member count', () => {
	it('counts the roster cache on a shared list and stays silent on a solo one', async () => {
		await putMyList('list-shared', 'Familie');
		await putMyList('list-solo', 'Solo');
		await putList('list-shared', '2026-01-01T00:00:00.000Z');
		await putList('list-solo', '2026-01-01T00:00:00.000Z');
		await db.roster.bulkPut([
			roster('list-shared', 'account-1', 'Anna'),
			roster('list-shared', 'account-2', 'Ben'),
			// A solo list's own roster row must not read as shared — 1 is "only me",
			// and neither must an empty cache (§7.4 refreshes it on three triggers).
			roster('list-solo', 'account-1', 'Anna')
		]);

		render(ListsHome);

		await waitFor(() => {
			expect(within(cardByName('Familie')).getByText('· 2 Mitglieder')).toBeDefined();
			expect(within(cardByName('Solo')).queryByText(/Mitglied/)).toBeNull();
			expect(screen.queryByText('👥')).toBeNull();
		});
	});

	it('drops the marker when the roster falls back to a single member', async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');
		await db.roster.bulkPut([
			roster('list-a', 'account-1', 'Anna'),
			roster('list-a', 'account-2', 'Ben')
		]);
		render(ListsHome);
		await waitFor(() =>
			expect(within(cardByName('Familie')).getByText(/Mitglieder/)).toBeDefined()
		);

		await db.roster.delete('list-a_account-2');
		// Dropping back to one member drops the marker entirely rather than
		// rendering "1 Mitglied" — a list with only you on it is not shared.
		await waitFor(() => expect(within(cardByName('Familie')).queryByText(/Mitglied/)).toBeNull());
	});
});

describe('ListsHome header', () => {
	it('carries the ordering menu in the app bar, not in a row of its own', async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');
		render(ListsHome);

		const sort = await screen.findByTestId('list-sort');
		expect(sort.closest('header')).not.toBeNull();
		// The sort's label is the control's accessible name, with the active mode
		// appended.
		expect(sort.getAttribute('aria-label')).toBe('Sortierung: Aktivität');

		await selectSort('A–Z');
		await waitFor(async () => {
			expect((await db.meta.get('list_sort'))?.value).toBe('alphabetical');
			expect(screen.getByTestId('list-sort').getAttribute('aria-label')).toBe('Sortierung: A–Z');
		});
	});
});

describe('ListsHome unsynced badge', () => {
	it('shows the pending-op count for that list only', async () => {
		await putMyList('list-pending', 'Baustelle');
		await putMyList('list-clean', 'Fertig');
		await putList('list-pending', '2026-01-01T00:00:00.000Z');
		await putList('list-clean', '2026-01-01T00:00:00.000Z');
		await db.pending_ops.bulkPut([
			{
				op_id: 'op-1',
				collection: 'items',
				record_id: 'item-1',
				list_id: 'list-pending',
				type: 'create',
				changed: {},
				base: {},
				queued_at: '2026-01-01T00:00:00.000Z'
			},
			{
				op_id: 'op-2',
				collection: 'items',
				record_id: 'item-2',
				list_id: 'list-pending',
				type: 'update',
				changed: {},
				base: {},
				queued_at: '2026-01-01T00:00:00.000Z'
			}
		]);

		render(ListsHome);

		await waitFor(() => {
			expect(within(cardByName('Baustelle')).getByText('2 nicht synchronisiert')).toBeDefined();
			expect(within(cardByName('Fertig')).queryByText(/nicht synchronisiert/)).toBeNull();
		});
	});

	// The summary is aria-hidden under the covering link: its count and the
	// unsynced warning reach a screen reader as the link's description.
	it('describes each card link by its count and its unsynced changes', async () => {
		await putMyList('list-pending', 'Baustelle');
		await putList('list-pending', '2026-01-01T00:00:00.000Z');
		await db.pending_ops.put({
			op_id: 'op-1',
			collection: 'items',
			record_id: 'item-1',
			list_id: 'list-pending',
			type: 'create',
			changed: {},
			base: {},
			queued_at: '2026-01-01T00:00:00.000Z'
		});

		render(ListsHome);

		const link = await screen.findByRole('link', { name: 'Baustelle öffnen' });
		await waitFor(() => {
			const described = (link.getAttribute('aria-describedby') ?? '')
				.split(' ')
				.map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim())
				.filter(Boolean);
			expect(described).toEqual(['leer', '1 nicht synchronisiert']);
		});
	});
});

describe('ListsHome ordering modes', () => {
	// Either store's initial `[]` must not reach the reconcile effect as if it
	// were loaded: "no lists" would drop every saved id, "no order" would replace
	// it with the memberships' order.
	it('keeps the saved custom order across a fresh start', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		await putMyList('list-c', 'Banane');
		await listSort.set('custom');
		await listOrder.set(['list-c', 'list-a', 'list-b']);
		invalidateLiveCaches(); // an app start: no store has emitted yet

		render(ListsHome);

		await waitFor(() => {
			const cards = screen.getAllByRole('link', { name: /öffnen$/ });
			expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
				'Banane öffnen',
				'Zucker öffnen',
				'Äpfel öffnen'
			]);
		});
		expect((await db.meta.get('list_order'))?.value).toEqual(['list-c', 'list-a', 'list-b']);
	});

	it('orders by activity, alphabetical (umlaut-aware) and custom', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		await putMyList('list-c', 'Banane');
		// Activity ordering reads db.lists.updated (the digest max_updated), not items.
		await putList('list-a', '2026-01-03T00:00:00.000Z');
		await putList('list-b', '2026-01-02T00:00:00.000Z');
		await putList('list-c', '2026-01-01T00:00:00.000Z');

		render(ListsHome);

		// Default: recent activity, newest updated first.
		await waitFor(() => {
			const cards = screen.getAllByRole('link', { name: /öffnen$/ });
			expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
				'Zucker öffnen',
				'Äpfel öffnen',
				'Banane öffnen'
			]);
		});

		// Alphabetical: the collator must place Ä next to A, not after Z.
		await selectSort('A–Z');
		await waitFor(() => {
			const cards = screen.getAllByRole('link', { name: /öffnen$/ });
			expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
				'Äpfel öffnen',
				'Banane öffnen',
				'Zucker öffnen'
			]);
		});

		// Custom: follows the device-local meta.list_order id array.
		await listOrder.set(['list-c', 'list-a', 'list-b']);
		await selectSort('Eigene Reihenfolge');
		await waitFor(() => {
			const cards = screen.getAllByRole('link', { name: /öffnen$/ });
			expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
				'Banane öffnen',
				'Zucker öffnen',
				'Äpfel öffnen'
			]);
		});
	});

	// [D-90] Cards open their list and nothing else, in every order: no grip,
	// no drag zone, no focusable wrapper in front of the link.
	it('gives the cards no drag wiring in any order, custom included', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		await listSort.set('custom');
		render(ListsHome);
		await waitFor(() => expect(screen.getAllByRole('link', { name: /öffnen$/ })).toHaveLength(2));

		expect(document.querySelector('.arrange-handle')).toBeNull();
		for (const link of screen.getAllByRole('link', { name: /öffnen$/ })) {
			const wrapper = link.closest('.block') as Element;
			expect(wrapper.hasAttribute('tabindex')).toBe(false);
			expect(wrapper.parentElement?.hasAttribute('tabindex')).toBe(false);
			expect(
				cardByName(link.getAttribute('aria-label')!.replace(/ öffnen$/, '')).querySelector(
					'svg.lucide-grip-vertical'
				)
			).toBeNull();
		}
	});

	it('offers "Reihenfolge ändern" only with two lists or more', async () => {
		await putMyList('list-a', 'Zucker');
		render(ListsHome);
		await fireEvent.click(await screen.findByTestId('list-sort'));
		await screen.findByRole('menuitemradio', { name: 'Eigene Reihenfolge' });
		expect(screen.queryByRole('menuitem', { name: 'Reihenfolge ändern' })).toBeNull();
	});

	it('arranges from the order on screen, moves by arrow, and returns on Fertig', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		await putMyList('list-c', 'Banane');
		await putList('list-a', '2026-01-03T00:00:00.000Z');
		await putList('list-b', '2026-01-02T00:00:00.000Z');
		await putList('list-c', '2026-01-01T00:00:00.000Z');
		// A custom order saved long ago, not the one on screen.
		await listOrder.set(['list-c', 'list-b', 'list-a']);
		render(ListsHome);
		await waitFor(() => expect(screen.getAllByRole('link', { name: /öffnen$/ })).toHaveLength(3));

		await fireEvent.click(await screen.findByTestId('list-sort'));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reihenfolge ändern' }));

		// The arrangement starts from activity order, the one the user was looking at.
		await screen.findByRole('heading', { name: 'Listen anordnen' });
		const arranged = () =>
			[...document.querySelectorAll('.arrange-row')].map((r) => r.getAttribute('aria-label'));
		await waitFor(() => expect(arranged()).toEqual(['Zucker', 'Äpfel', 'Banane']));
		await waitFor(async () => expect((await db.meta.get('list_sort'))?.value).toBe('custom'));
		// Nothing in the mode opens a list, and the create/join footer gives way.
		expect(screen.queryAllByRole('link', { name: /öffnen$/ })).toHaveLength(0);
		expect(screen.queryByRole('button', { name: t('home_new_list') })).toBeNull();
		// Arrows show on the row whose handle was tapped, and a second tap on it
		// puts them away ([D-237]).
		expect(screen.queryByRole('button', { name: /nach (oben|unten)$/ })).toBeNull();
		const sugar = screen.getByRole('button', { name: 'Zucker verschieben' });
		await fireEvent.click(sugar);
		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Zucker nach oben' }).disabled
		).toBe(true);
		await fireEvent.click(sugar);
		expect(screen.queryByRole('button', { name: /nach (oben|unten)$/ })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Banane verschieben' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Banane nach oben' }));
		await waitFor(() => expect(arranged()).toEqual(['Zucker', 'Banane', 'Äpfel']));
		await waitFor(async () =>
			expect((await db.meta.get('list_order'))?.value).toEqual(['list-a', 'list-c', 'list-b'])
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
		await waitFor(() => {
			const cards = screen.getAllByRole('link', { name: /öffnen$/ });
			expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
				'Zucker öffnen',
				'Banane öffnen',
				'Äpfel öffnen'
			]);
		});
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('list-sort')));
	});

	// [D-237] On a touchscreen svelte-dnd-action swallows the tap's click, so
	// the grip reads the tap off its pointer events; a mouse clicks right
	// after them, and that click must not count the same tap twice. A screen
	// reader's double-tap is a lone click, which must still toggle.
	it('shows the arrows for a touch tap on the grip, which brings no click', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		render(ListsHome);
		await waitFor(() => expect(screen.getAllByRole('link', { name: /öffnen$/ })).toHaveLength(2));
		await fireEvent.click(await screen.findByTestId('list-sort'));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reihenfolge ändern' }));
		const grip = await screen.findByRole('button', { name: 'Äpfel verschieben' });
		const arrows = () => screen.queryAllByRole('button', { name: /^Äpfel nach (oben|unten)$/ });
		const nextTask = () => new Promise((resolve) => setTimeout(resolve));

		// A finger: down and up in place, and no click.
		await fireEvent.pointerDown(grip, { clientX: 20, clientY: 20, pointerType: 'touch' });
		await fireEvent.pointerUp(grip, { clientX: 21, clientY: 20, pointerType: 'touch' });
		expect(arrows()).toHaveLength(2);
		expect(grip.getAttribute('aria-pressed')).toBe('true');

		// A screen reader's double-tap, later: a click alone puts them away.
		await nextTask();
		await fireEvent.click(grip);
		expect(arrows()).toHaveLength(0);

		// A mouse: the click that follows its pointer events is the same tap.
		await fireEvent.pointerDown(grip, { clientX: 20, clientY: 20, pointerType: 'mouse' });
		await fireEvent.pointerUp(grip, { clientX: 20, clientY: 20, pointerType: 'mouse' });
		await fireEvent.click(grip);
		expect(arrows()).toHaveLength(2);
	});

	// The mode is a history entry: the system back closes it (on the home, the
	// app's root, back would otherwise leave the app), and Fertig closes it by
	// going back over that entry rather than stacking another.
	it('closes the arrangement on the system back, and Fertig goes back over its entry', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		render(ListsHome);
		const enter = async () => {
			await fireEvent.click(await screen.findByTestId('list-sort'));
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reihenfolge ändern' }));
			await screen.findByRole('heading', { name: 'Listen anordnen' });
		};

		await enter();
		expect(appState.page.state).toEqual({ mode: 'arrange-lists' });
		appState.historyBack(); // the browser's back pops the entry
		await screen.findByRole('heading', { name: 'Meine Listen' });
		expect(screen.getAllByRole('link', { name: /öffnen$/ })).toHaveLength(2);
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('list-sort')));

		await enter();
		await fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
		await screen.findByRole('heading', { name: 'Meine Listen' });
		expect(appState.historyEntries().index).toBe(0);
	});

	// [D-230] On the home, the app's root, a back that was not caught closed
	// the app. A dialog opened from a card's menu takes the menu's place in
	// history, so one back closes it and the home stays.
	it('closes a dialog opened from a card menu on the system back, staying home', async () => {
		await putMyList('list-a', 'Familie');
		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Umbenennen' }));
		await screen.findByRole('dialog', { name: 'Umbenennen' });
		await waitFor(() => {
			expect(appState.page.state.overlays).toHaveLength(1);
			expect(appState.historyEntries().index).toBe(1);
		});

		appState.historyBack();

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(appState.historyEntries().index).toBe(0);
		expect(screen.getByRole('heading', { name: 'Meine Listen' })).toBeDefined();
	});

	it('persists a drag in the arrangement through the zone finalize event', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		await putMyList('list-c', 'Banane');
		await listSort.set('custom');
		await listOrder.set(['list-a', 'list-b', 'list-c']);
		render(ListsHome);
		await fireEvent.click(await screen.findByTestId('list-sort'));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reihenfolge ändern' }));
		await waitFor(() => expect(document.querySelectorAll('.arrange-row')).toHaveLength(3));

		// svelte-dnd-action dispatches `finalize` on the zone with the new id
		// order; the DOM reorder itself is the library's domain.
		const zone = document.querySelector('.arrange-list') as Element;
		await fireEvent(
			zone,
			new CustomEvent('finalize', {
				bubbles: true,
				detail: {
					items: [{ id: 'list-c' }, { id: 'list-b' }, { id: 'list-a' }],
					info: { trigger: 'droppedIntoZone', id: 'list-c', source: 'pointer' }
				}
			})
		);
		await waitFor(async () =>
			expect((await db.meta.get('list_order'))?.value).toEqual(['list-c', 'list-b', 'list-a'])
		);
	});

	it('keeps a gap under the finger while a row is in the air', async () => {
		await putMyList('list-a', 'Zucker');
		await putMyList('list-b', 'Äpfel');
		await putMyList('list-c', 'Banane');
		await listSort.set('custom');
		await listOrder.set(['list-a', 'list-b', 'list-c']);
		render(ListsHome);
		await fireEvent.click(await screen.findByTestId('list-sort'));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reihenfolge ändern' }));
		await waitFor(() => expect(document.querySelectorAll('.arrange-row')).toHaveLength(3));

		// What svelte-dnd-action dispatches the moment 'Äpfel' leaves the list:
		// the grabbed item is replaced by a SHADOW item — a placeholder id plus
		// the marker — and that shadow is the hole the row drops into. Mirroring
		// the event down to bare ids would drop it, and the list would close up
		// with nowhere to land until the drag crossed into another index.
		await fireEvent(
			document.querySelector('.arrange-list') as Element,
			new CustomEvent('consider', {
				bubbles: true,
				detail: {
					items: [
						{ id: 'list-a' },
						{ id: SHADOW_PLACEHOLDER_ITEM_ID, [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true },
						{ id: 'list-c' }
					],
					info: { trigger: 'dragStarted', id: 'list-b', source: 'pointer' }
				}
			})
		);

		// Three rows still, the middle one standing in for the row in the air.
		await waitFor(() =>
			expect(
				[...document.querySelectorAll('.arrange-row')].map((r) => r.getAttribute('aria-label'))
			).toEqual(['Zucker', 'Äpfel', 'Banane'])
		);
	});
});

// Leaving from the home screen is the shortest route to the most destructive
// thing in the product: the §7.3 last-one-out hook cascade-deletes the list and
// everything in it server-side. The confirmation is an in-app ConfirmDialog, so
// these drive the real dialog: the confirmation is a rendered element with the
// list's name in it, and the destructive action is a button that has to be
// clicked.
describe('ListsHome leave (§7.2)', () => {
	async function seedOneList(): Promise<void> {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');
	}

	async function openMenu(): Promise<void> {
		render(ListsHome);
		const menuBtn = await screen.findByRole('button', { name: 'Aktionen für Familie' });
		await fireEvent.click(menuBtn);
	}

	async function openLeaveDialog(): Promise<HTMLElement> {
		await openMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Liste verlassen' }));
		return await screen.findByRole('alertdialog', { name: 'Liste verlassen' });
	}

	async function seedMembers(...accounts: string[]): Promise<void> {
		await db.roster.bulkPut(
			accounts.map((account) => ({
				id: `list-a_${account}`,
				list: 'list-a',
				account,
				nickname: account,
				joined: '2026-01-01T00:00:00.000Z'
			}))
		);
	}

	it('names the list in the confirmation and leaves once it is confirmed', async () => {
		await seedOneList();
		await seedMembers('Anna', 'Ben');

		const dialog = await openLeaveDialog();
		expect(within(dialog).getByText('„Familie“ wirklich verlassen?')).toBeDefined();
		// Nothing has happened yet — opening the dialog is not consent.
		expect(vi.mocked(leaveList)).not.toHaveBeenCalled();

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Liste verlassen' }));
		await waitFor(() => expect(vi.mocked(leaveList)).toHaveBeenCalledWith('list-a'));
	});

	// [D-293] The last member out deletes the list for everyone (§7.3).
	it('says that leaving deletes the list when no one else is on it', async () => {
		await seedOneList();
		await seedMembers('Anna');

		const dialog = await openLeaveDialog();

		await waitFor(() =>
			expect(dialog.textContent).toContain('Du bist das einzige Mitglied von „Familie“')
		);
		expect(dialog.textContent).toContain('gelöscht');
	});

	it('does nothing when the confirmation is cancelled', async () => {
		await seedOneList();

		const dialog = await openLeaveDialog();
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(vi.mocked(leaveList)).not.toHaveBeenCalled();
	});

	it('keeps the dialog open and shows the error when the leave fails', async () => {
		await seedOneList();
		vi.mocked(leaveList).mockRejectedValueOnce(new Error('offline mid-flight'));

		const dialog = await openLeaveDialog();
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Liste verlassen' }));

		// The old native-dialog path could only fire a toast at an already-closed
		// prompt; the sheet has to survive its own failure so the user can retry.
		await waitFor(() => expect(within(dialog).getByRole('alert')).toBeDefined());
		expect(screen.getByRole('alertdialog', { name: 'Liste verlassen' })).toBeDefined();
	});

	it('refuses to leave while offline — it cannot be queued ([D-09])', async () => {
		await seedOneList();
		online.set(false);

		await openMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Liste verlassen' }));

		// Not even asked: a leave is an online-only server delete, and a
		// half-applied local purge would lose the list with no way back.
		expect(screen.queryByRole('alertdialog', { name: 'Liste verlassen' })).toBeNull();
		expect(vi.mocked(leaveList)).not.toHaveBeenCalled();
	});
});

// [D-270] The card's ⋮ offers what the ⋮ inside the list offers, in its
// order, but the categories, which are edited from inside the list ([D-271]).
describe('ListsHome card menu ([D-270])', () => {
	it("offers the in-list sheet's actions in its order, without the categories", async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));

		await screen.findByRole('menuitem', { name: t('home_action_share') });
		expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual(
			LIST_ACTIONS.filter((a) => a.id !== 'categories').map((a) => t(a.label))
		);
	});

	it('greys out what needs the server while offline', async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');
		online.set(false);

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));

		for (const action of HOME_ACTIONS) {
			const item = await screen.findByRole('menuitem', { name: t(action.label) });
			expect(item.hasAttribute('data-disabled')).toBe(action.online);
		}
	});
});

// Clone/export are the per-card quick actions added with the backup feature
// ([D-72]): the menu has to surface them next to rename/share.
describe('ListsHome clone/export menu', () => {
	it('shows Duplizieren and Backup exportieren in the card menu', async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));

		expect(await screen.findByRole('menuitem', { name: 'Duplizieren' })).toBeDefined();
		expect(await screen.findByRole('menuitem', { name: 'Backup exportieren' })).toBeDefined();
	});

	it("prefills the clone's name through the locale's message", async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplizieren' }));

		const dialog = await screen.findByRole('dialog', { name: 'Liste duplizieren' });
		expect(within(dialog).getByLabelText<HTMLInputElement>('Name der Kopie').value).toBe(
			'Familie (Kopie)'
		);
	});

	// [D-254] Import is a screen (text or a backup file), and offline too: text
	// into an existing list goes through the outbox.
	it('opens the import screen, online or not', async () => {
		await putMyList('list-a', 'Familie');
		online.set(false);
		render(ListsHome);

		await fireEvent.click(await screen.findByRole('button', { name: 'Liste importieren' }));

		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/import', {
				state: { from: '/' },
				persistState: true
			})
		);
		expect(document.querySelector('input[type="file"]')).toBeNull();
	});

	// Closing the system share sheet is an answer, not an export failure.
	it('says nothing when the share sheet is dismissed', async () => {
		vi.mocked(exportList).mockResolvedValueOnce(false);
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Backup exportieren' }));

		await waitFor(() => expect(vi.mocked(exportList)).toHaveBeenCalledWith('list-a'));
		await new Promise((r) => setTimeout(r, 0));
		expect(vi.mocked(showToast)).not.toHaveBeenCalled();
	});
});

// Create/join/rename used window.prompt, which meant the app's single most
// common first action — naming your first list — handed off to browser chrome.
// These cover the replacement sheets end to end.
describe('ListsHome create/join/rename dialogs', () => {
	it('creates a list from the in-app prompt rather than a native dialog', async () => {
		// happy-dom has no native dialogs at all; give it one to spy on.
		if (typeof window.prompt !== 'function') Object.assign(window, { prompt: () => null });
		const promptSpy = vi.spyOn(window, 'prompt');
		vi.mocked(createList).mockResolvedValueOnce('list-new');
		await putMyList('list-a', 'Alltag');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Neue Liste' }));

		const dialog = await screen.findByRole('dialog', { name: 'Neue Liste' });
		const input = within(dialog).getByLabelText('Name der Liste');
		await fireEvent.input(input, { target: { value: '  Wocheneinkauf  ' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Neue Liste' }));

		// Trimmed on the way out, exactly as the prompt path did.
		await waitFor(() => expect(vi.mocked(createList)).toHaveBeenCalledWith('Wocheneinkauf'));
		expect(promptSpy).not.toHaveBeenCalled();
		promptSpy.mockRestore();
	});

	// [D-325] The button stays enabled and says what is missing.
	it('refuses to submit an empty name, and says so', async () => {
		await putMyList('list-a', 'Alltag');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Neue Liste' }));

		const dialog = await screen.findByRole('dialog', { name: 'Neue Liste' });
		const submit = within(dialog).getByRole('button', { name: 'Neue Liste' });
		expect(submit).toHaveProperty('disabled', false);

		await fireEvent.input(within(dialog).getByLabelText('Name der Liste'), {
			target: { value: '   ' }
		});
		await fireEvent.click(submit);
		expect(within(dialog).getByRole('alert').textContent?.trim()).toBe('Bitte zuerst ausfüllen.');
		expect(vi.mocked(createList)).not.toHaveBeenCalled();
	});

	it('seeds the rename dialog with the current name', async () => {
		await putMyList('list-a', 'Familie');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für Familie' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Umbenennen' }));

		const dialog = await screen.findByRole('dialog', { name: 'Umbenennen' });
		// [D-08]: the name is the list's, so the dialog says who it changes it for.
		expect(within(dialog).getByText('Der neue Name gilt für alle Mitglieder.')).toBeDefined();
		const input = within(dialog).getByLabelText<HTMLInputElement>('Name');
		expect(input.value).toBe('Familie');

		await fireEvent.input(input, { target: { value: 'Zuhause' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
		await waitFor(() => expect(vi.mocked(renameList)).toHaveBeenCalledWith('list-a', 'Zuhause'));
	});

	// [D-08]: the card is named from the list row, which a cycle rewrites when
	// a co-member renames the list — the home follows without a reload.
	it('follows a co-member’s rename of the list', async () => {
		await putMyList('list-a', 'Familie');

		render(ListsHome);
		expect(await screen.findByRole('link', { name: 'Familie öffnen' })).toBeDefined();

		await db.lists.update('list-a', { name: 'Großfamilie' });

		expect(await screen.findByRole('link', { name: 'Großfamilie öffnen' })).toBeDefined();
		expect(screen.queryByRole('link', { name: 'Familie öffnen' })).toBeNull();
	});

	it('asks for the invite in-app instead of via window.prompt', async () => {
		// happy-dom has no native dialogs at all; give it one to spy on.
		if (typeof window.prompt !== 'function') Object.assign(window, { prompt: () => null });
		const promptSpy = vi.spyOn(window, 'prompt');
		await putMyList('list-a', 'Alltag');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		render(ListsHome);
		await fireEvent.click(await screen.findByRole('button', { name: 'Mit Einladung beitreten' }));

		// The handoff to the join screen itself is a `location.href` assignment
		// (the token must be in the fragment on first paint), a full page load a
		// component test does not follow — so this covers the part that
		// changed: the ask.
		const dialog = await screen.findByRole('dialog', { name: 'Mit Einladung beitreten' });
		expect(within(dialog).getByLabelText('Einladungslink oder Code')).toBeDefined();
		expect(promptSpy).not.toHaveBeenCalled();
		promptSpy.mockRestore();
	});
});

// The cold-start welcome is the ONLY screen a brand-new account sees, and
// every door to /settings (the populated header's gear, the list-settings
// sheet's app-settings row) presupposes a first list — without this link,
// logout and account deletion are unreachable. Regression guard for exactly
// that gap.
describe('ListsHome cold-start empty state', () => {
	it('links to settings before the first list exists', async () => {
		render(ListsHome);

		await waitFor(() => {
			expect(screen.getByText('Willkommen!')).toBeDefined();
		});

		const gear = screen.getByRole('link', { name: 'Einstellungen' });
		expect(gear.getAttribute('href')).toBe('/settings');
	});
});

// [D-130]: the §12.1 chip mounts in the home's app bar too, so an expired
// session reached on the home has a control to clear it. Both home states get
// one — including the zero-list state, which is exactly the account that cannot
// "just open a list".
describe('ListsHome — the sync chip rides in the home app bar ([D-130])', () => {
	const chip = () => screen.queryByRole('status', { name: 'Synchronisierungsstatus' });

	it('carries the chip beside the title once there are lists', async () => {
		await putMyList('list-a', 'Wocheneinkauf');
		await putList('list-a', '2026-01-01T00:00:00.000Z');
		render(ListsHome);

		await waitFor(() => expect(screen.getByText('Wocheneinkauf')).toBeDefined());
		expect(chip()).not.toBeNull();
	});

	it('carries it in the zero-list state too, where there is no list to open', async () => {
		render(ListsHome);

		await waitFor(() => expect(screen.getByText('Willkommen!')).toBeDefined());
		expect(chip()).not.toBeNull();
	});
});

// [D-182]: a fresh sign-in starts from an empty mirror. The welcome screen with
// its create/join must wait for the first cycle — otherwise a returning user,
// tired of waiting, creates lists they already have.
describe('ListsHome before the first membership pull ([D-182])', () => {
	beforeEach(async () => {
		await db.meta.delete('memberships_synced_at');
	});

	it('says it is loading and offers no create/join until the pull answers', async () => {
		render(ListsHome);

		await waitFor(() => expect(screen.getByText('Deine Listen werden geladen …')).toBeDefined());
		expect(screen.queryByText('Willkommen!')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Neue Liste' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Mit Einladung beitreten' })).toBeNull();
		// The doors a zero-list account needs anyway (sign-out, re-auth) stay.
		expect(screen.getByRole('link', { name: 'Einstellungen' })).toBeDefined();
		expect(screen.queryByRole('status', { name: 'Synchronisierungsstatus' })).not.toBeNull();
	});

	it('shows the lists as soon as they arrive, before the cycle is stamped', async () => {
		render(ListsHome);
		await waitFor(() => expect(screen.getByTestId('home-loading')).toBeDefined());

		await putMyList('list-a', 'Wocheneinkauf');
		await putList('list-a', '2026-01-01T00:00:00.000Z');

		await waitFor(() => expect(screen.getByText('Wocheneinkauf')).toBeDefined());
		expect(screen.queryByTestId('home-loading')).toBeNull();
	});

	it('turns into the welcome screen once an empty pull is recorded', async () => {
		render(ListsHome);
		await waitFor(() => expect(screen.getByTestId('home-loading')).toBeDefined());

		await markPulled();

		await waitFor(() => expect(screen.getByText('Willkommen!')).toBeDefined());
		expect(screen.queryByTestId('home-loading')).toBeNull();
	});

	it('says why it is waiting when offline', async () => {
		online.set(false);
		render(ListsHome);

		await waitFor(() =>
			expect(
				screen.getByText('Du bist offline. Deine Listen erscheinen, sobald du verbunden bist.')
			).toBeDefined()
		);
	});

	// [D-182] The pull cannot land while the session is expired, so the spinner
	// would spin forever beside the app bar's small red chip — the one way out —
	// unless the screen asks for the re-auth itself.
	describe('with an expired session', () => {
		beforeEach(() => authState.set({ nickname: 'Anna', isValid: false }));
		afterEach(() => authState.set({ nickname: 'Anna', isValid: true }));

		it('asks for the re-auth instead of loading forever', async () => {
			render(ListsHome);

			await waitFor(() => expect(screen.getByTestId('home-expired')).toBeDefined());
			expect(screen.queryByTestId('home-loading')).toBeNull();
			// One way to sign in, not two: the chip's action is the prompt's button.
			expect(screen.getAllByRole('button', { name: /anmelden/ })).toHaveLength(1);
			await fireEvent.click(screen.getByRole('button', { name: 'Erneut anmelden' }));
			await waitFor(() => expect(vi.mocked(login)).toHaveBeenCalledOnce());
		});

		it('still says it is offline when there is no connection to sign in over', async () => {
			online.set(false);
			render(ListsHome);

			await waitFor(() => expect(screen.getByTestId('home-loading')).toBeDefined());
			expect(screen.queryByTestId('home-expired')).toBeNull();
		});
	});

	it('says it is still trying when the pull takes long', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			render(ListsHome);
			await waitFor(() => expect(screen.getByTestId('home-loading')).toBeDefined());
			expect(screen.queryByText(/länger als üblich/)).toBeNull();

			await vi.advanceTimersByTimeAsync(8000);

			await waitFor(() => expect(screen.getByText(/länger als üblich/)).toBeDefined());
		} finally {
			vi.useRealTimers();
		}
	});
});
