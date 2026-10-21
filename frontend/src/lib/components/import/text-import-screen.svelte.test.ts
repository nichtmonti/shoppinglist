// [D-254] the import screen: a text list is reviewed before anything is
// written, and the review is what gets written. The two write paths are
// stubbed (#lib/actions has its own suites); what this suite owns is that the
// confirmation shows the right rows and hands exactly the selected ones on.
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

vi.mock('#lib/state/online.js', async () => {
	const { writable } = await import('svelte/store');
	return { online: writable(true), isOnline: () => true };
});

vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock()
);

vi.mock('#lib/actions/lists.js', async (importOriginal) => ({
	importFailureMessage: (await importOriginal<typeof import('#lib/actions/lists.js')>())
		.importFailureMessage,
	importBackup: vi.fn().mockResolvedValue({ ok: true, id: 'list-new' }),
	importListFromFile: vi.fn()
}));

// The instance's item cap ([D-217]), lowered by the one test that needs it.
const cap = vi.hoisted(() => ({ value: Infinity, list: Infinity }));
vi.mock('#lib/config.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/config.js')>()),
	get IMPORT_MAX_ITEMS() {
		return cap.value;
	}
}));

vi.mock('#lib/actions/items.js', () => ({
	addImported: vi.fn(async (_list: string, rows: unknown[]) => rows.length),
	// list-a holds one row, Brot.
	roomOnList: vi.fn(async () => cap.list - 1)
}));

import { db } from '#lib/db.js';
import {
	makeCategory,
	makeItem,
	makeTemplate,
	putMyList,
	putSynced,
	resetDb
} from '#lib/test-kit/db.js';
import { online as onlineStore } from '#lib/state/online.js';
import { importBackup, importListFromFile } from '#lib/actions/lists.js';
import { BACKUP_FORMAT } from '#lib/field-contract.js';
import { addImported } from '#lib/actions/items.js';
import { showToast } from '#lib/toasts.js';
import { goto } from '$app/navigation';
import TextImportScreen from './TextImportScreen.svelte';
import { subScreen } from '#lib/components/common/sub-screen.svelte.js';

const online = onlineStore as unknown as { set(value: boolean): void };

const TEMPLATES = [
	makeTemplate({
		slug: 'produce',
		name_i18n: { de: 'Obst & Gemüse', en: 'Produce' },
		sort_order: 1
	}),
	makeTemplate({
		slug: 'bakery',
		name_i18n: { de: 'Brot & Backwaren', en: 'Bakery' },
		sort_order: 2
	}),
	makeTemplate({
		slug: 'dairy_eggs',
		name_i18n: { de: 'Milchprodukte & Eier', en: 'Dairy & Eggs' },
		sort_order: 3
	}),
	makeTemplate({ slug: 'other', sort_order: 21 })
];

const SHARE = `Hamburg

[Obst - Gemüse - Nüsse]
Mango
Paprika, rot

[Backwaren]
Brot

[Kühltheke - Milchprodukte]
Erbsenmilch
`;

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	cap.value = Infinity;
	cap.list = Infinity;
	online.set(true);
	await db.category_templates.bulkPut(TEMPLATES);
	await db.item_dictionary.bulkPut([
		{ id: 'i1', names_i18n: { de: ['Mango'] }, default_category: 'produce', popularity: 1 },
		{ id: 'i2', names_i18n: { de: ['Milch'] }, default_category: 'dairy_eggs', popularity: 1 }
	]);
	await putMyList('list-a', 'Zuhause');
	await putSynced(
		[makeItem({ list: 'list-a', name: 'Brot', category_key: 'a-bakery' })],
		TEMPLATES.map((t) =>
			makeCategory({
				list: 'list-a',
				id: `a-${t.slug}`,
				slug: t.slug,
				name: null,
				sort_order: t.sort_order
			})
		)
	);
});

/** The review's row for `name`. */
function rowOf(name: string): HTMLElement {
	const row = [...document.querySelectorAll<HTMLElement>('[data-import-row]')].find(
		(r) => r.querySelector('[id^="import-name-"]')?.textContent.trim() === name
	);
	if (!row) throw new Error(`no review row ${name}`);
	return row;
}

/** The review's rows, by name, with whether each is ticked. */
function rows(): [string, boolean][] {
	return [...document.querySelectorAll<HTMLLabelElement>('[data-import-row]')].map((label) => [
		label.querySelector('[id^="import-name-"]')!.textContent.trim(),
		label.querySelector('[role="checkbox"]')!.getAttribute('aria-checked') === 'true'
	]);
}

describe('TextImportScreen', () => {
	it('names itself in its app bar, beside the sync chip', () => {
		render(TextImportScreen);
		// The title once rendered empty: a variable named like the bar's
		// `title` snippet was shadowed by it.
		expect(screen.getByRole('heading', { level: 1 }).textContent?.trim()).toBe('Liste importieren');
		expect(screen.getByRole('status', { name: 'Synchronisierungsstatus' })).toBeDefined();
	});

	it('opens a share on its review: every item under its aisle, named after the list', async () => {
		render(TextImportScreen, { sharedText: SHARE });

		const button = await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' });
		expect(screen.getByLabelText<HTMLInputElement>('Name der neuen Liste').value).toBe('Hamburg');
		await waitFor(() =>
			expect(screen.getAllByRole('heading').map((h) => h.textContent?.trim())).toEqual(
				expect.arrayContaining([expect.stringContaining('Obst & Gemüse')])
			)
		);
		expect(rows()).toEqual([
			['Mango', true],
			['Paprika, rot', true],
			['Brot', true],
			['Erbsenmilch', true]
		]);
		expect(importBackup).not.toHaveBeenCalled();
		expect(button).toBeDefined();
	});

	it('creates the list with only the ticked items', async () => {
		render(TextImportScreen, { sharedText: SHARE });
		await fireEvent.click(await screen.findByRole('checkbox', { name: 'Paprika, rot' }));
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Liste mit 3 Artikeln erstellen' })
		);

		await waitFor(() => expect(importBackup).toHaveBeenCalledTimes(1));
		const [backup, name] = vi.mocked(importBackup).mock.calls[0];
		expect(name).toBe('Hamburg');
		expect(backup.items.map((i) => i.name)).toEqual(['Mango', 'Brot', 'Erbsenmilch']);
		const slugOf = (key: string | null) => backup.categories.find((c) => c.key === key)?.slug;
		expect(backup.items.map((i) => slugOf(i.category_key))).toEqual([
			'produce',
			'bakery',
			'dairy_eggs'
		]);
		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/list/list-new', expect.anything())
		);
	});

	// The server refuses a list over the cap, and „Import fehlgeschlagen“
	// would not say to untick rows.
	it('says how many items a new list may take when more are ticked', async () => {
		cap.value = 3;
		render(TextImportScreen, { sharedText: SHARE });
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' })
		);

		expect(
			await screen.findByText(
				'4 Artikel sind ausgewählt, eine neue Liste nimmt hier höchstens 3 auf. Wähle einige ab.'
			)
		).toBeDefined();
		expect(importBackup).not.toHaveBeenCalled();
	});

	// [D-219] [D-72]: a refused import says why, and the review stays up to act on it.
	it.each([
		{
			outcome: { ok: false, reason: 'list_limit', max: 25 } as const,
			message:
				'Du bist schon auf 25 Listen, mehr gehen hier nicht. Verlasse eine, um eine neue zu erstellen.'
		},
		{
			outcome: { ok: false, reason: 'failed', error: new Error('500') } as const,
			message: 'Import fehlgeschlagen'
		}
	])(
		'says why the server refused the new list ($outcome.reason), and stays',
		async ({ outcome, message }) => {
			vi.mocked(importBackup).mockResolvedValueOnce(outcome);
			render(TextImportScreen, { sharedText: SHARE });
			const confirm = await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' });

			await fireEvent.click(confirm);

			expect((await screen.findByRole('alert')).textContent).toBe(message);
			// Still the review, ready for another try: not the text, not the list.
			expect(screen.queryByLabelText('Liste als Text')).toBeNull();
			expect(screen.getByLabelText<HTMLInputElement>('Name der neuen Liste').value).toBe('Hamburg');
			await waitFor(() => expect(confirm).toHaveProperty('disabled', false));
			expect(goto).not.toHaveBeenCalled();
		}
	);

	it('checks against an existing list, and adds only what it lacks', async () => {
		render(TextImportScreen, { sharedText: SHARE });
		await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' });

		await screen.findByRole('option', { name: 'Zuhause' });
		await fireEvent.change(screen.getByLabelText('Wohin?'), { target: { value: 'list-a' } });

		const button = await screen.findByRole('button', { name: '3 Artikel hinzufügen' });
		const brot = await screen.findByRole('checkbox', {
			name: 'Brot',
			description: 'schon auf der Liste'
		});
		expect(brot).toHaveProperty('disabled', true);

		await fireEvent.click(button);
		await waitFor(() => expect(addImported).toHaveBeenCalledTimes(1));
		const [list, added] = vi.mocked(addImported).mock.calls[0];
		expect(list).toBe('list-a');
		expect(added.map((r) => [r.name, r.categoryKey])).toEqual([
			['Mango', 'a-produce'],
			['Paprika, rot', 'a-produce'],
			['Erbsenmilch', 'a-dairy_eggs']
		]);
		expect(showToast).toHaveBeenCalledWith('3 Artikel hinzugefügt');
	});

	// Rows written into a list that is gone are refused after the toast said
	// they were added: the review falls back to a new list instead.
	it('falls back to a new list when the target list goes away', async () => {
		render(TextImportScreen, { sharedText: SHARE });
		await screen.findByRole('option', { name: 'Zuhause' });
		await fireEvent.change(screen.getByLabelText('Wohin?'), { target: { value: 'list-a' } });
		await screen.findByRole('button', { name: '3 Artikel hinzufügen' });

		// A co-member deletes it, or this account leaves it on another device.
		await db.memberships.where('list').equals('list-a').delete();

		const button = await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' });
		expect(screen.getByLabelText('Wohin?')).toHaveProperty('value', '');
		await fireEvent.click(button);
		await waitFor(() => expect(importBackup).toHaveBeenCalledTimes(1));
		expect(addImported).not.toHaveBeenCalled();
	});

	// [D-217] The server refuses each create past a list's cap, after the
	// toast has counted it: the review says how many fit before writing.
	it('says how many more an existing list can take, before adding any', async () => {
		cap.list = 3; // room for two beside Brot
		render(TextImportScreen, { sharedText: SHARE });
		await screen.findByRole('option', { name: 'Zuhause' });
		await fireEvent.change(screen.getByLabelText('Wohin?'), { target: { value: 'list-a' } });
		await fireEvent.click(await screen.findByRole('button', { name: '3 Artikel hinzufügen' }));

		expect(
			await screen.findByText('In diese Liste passen nur noch 2 Artikel. Wähle einige ab.')
		).toBeDefined();
		expect(addImported).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('checkbox', { name: 'Mango' }));
		await fireEvent.click(await screen.findByRole('button', { name: '2 Artikel hinzufügen' }));
		await waitFor(() => expect(addImported).toHaveBeenCalledTimes(1));
	});

	// [D-254] An aisle chosen in the review is the aisle it is on any target:
	// picked while the target is a new list, it lands in the same seeded aisle
	// of the list switched to, not under the new list's id for it.
	it('carries an aisle chosen in the review to the target switched to', async () => {
		render(TextImportScreen, { sharedText: SHARE });
		await screen.findByRole('checkbox', { name: 'Mango' });

		await fireEvent.click(within(rowOf('Mango')).getByRole('button', { name: 'Mango' }));
		const sheet = await screen.findByRole('dialog', { name: 'Artikel bearbeiten' });
		await fireEvent.click(within(sheet).getByRole('radio', { name: 'Brot & Backwaren' }));
		await fireEvent.click(within(sheet).getByRole('button', { name: 'Schließen' }));

		await screen.findByRole('option', { name: 'Zuhause' });
		await fireEvent.change(screen.getByLabelText('Wohin?'), { target: { value: 'list-a' } });
		await fireEvent.click(await screen.findByRole('button', { name: '3 Artikel hinzufügen' }));

		await waitFor(() => expect(addImported).toHaveBeenCalledTimes(1));
		const [, added] = vi.mocked(addImported).mock.calls[0];
		expect(added.map((r) => [r.name, r.categoryKey])).toEqual([
			['Mango', 'a-bakery'],
			['Paprika, rot', 'a-produce'],
			['Erbsenmilch', 'a-dairy_eggs']
		]);
	});

	it('opened from a list, targets that list and works offline', async () => {
		online.set(false);
		render(TextImportScreen, { listId: 'list-a' });

		await fireEvent.input(screen.getByLabelText('Liste als Text'), {
			target: { value: 'Mango\nBrot' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

		const button = await screen.findByRole('button', { name: '1 Artikel hinzufügen' });
		expect(button).toHaveProperty('disabled', false);
		expect(screen.queryByRole('button', { name: 'Backup-Datei wählen …' })).toBeNull();
	});

	it('needs a connection for a new list', async () => {
		online.set(false);
		render(TextImportScreen, { sharedText: SHARE });

		const button = await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' });
		expect(button).toHaveProperty('disabled', true);
		expect(screen.getByText('Dafür brauchst du eine Verbindung.')).toBeDefined();
	});

	it('goes back to the text, and an unchanged text keeps its ticks and name', async () => {
		render(TextImportScreen, { sharedText: SHARE });
		await fireEvent.click(await screen.findByRole('checkbox', { name: 'Paprika, rot' }));
		await fireEvent.input(screen.getByLabelText('Name der neuen Liste'), {
			target: { value: 'Wochenende' }
		});

		// The footer's „Zurück"; the bar's ‹ does the same in the review.
		await fireEvent.click(screen.getAllByRole('button', { name: 'Zurück' }).at(-1)!);
		const text = await screen.findByLabelText<HTMLTextAreaElement>('Liste als Text');
		expect(text.value).toBe(SHARE);
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

		expect(
			(await screen.findByRole('checkbox', { name: 'Paprika, rot' })).getAttribute('aria-checked')
		).toBe('false');
		expect(screen.getByLabelText<HTMLInputElement>('Name der neuen Liste').value).toBe(
			'Wochenende'
		);

		// A changed text is a new review.
		await fireEvent.click(screen.getAllByRole('button', { name: 'Zurück' }).at(-1)!);
		await fireEvent.input(await screen.findByLabelText('Liste als Text'), {
			target: { value: `${SHARE}Käse\n` }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
		expect(
			(await screen.findByRole('checkbox', { name: 'Paprika, rot' })).getAttribute('aria-checked')
		).toBe('true');
		expect(screen.getByLabelText<HTMLInputElement>('Name der neuen Liste').value).toBe('Hamburg');
	});

	it("edits a row's quantity in place and its name in the item sheet, into the import", async () => {
		render(TextImportScreen, { sharedText: SHARE });
		await screen.findByRole('checkbox', { name: 'Mango' });

		await fireEvent.click(screen.getByRole('button', { name: 'Menge hinzufügen: Mango' }));
		const quantity = within(rowOf('Mango')).getByRole('textbox', { name: 'Menge bearbeiten' });
		await fireEvent.input(quantity, { target: { value: '3' } });
		await fireEvent.keyDown(quantity, { key: 'Enter' });

		await fireEvent.click(
			within(rowOf('Erbsenmilch')).getByRole('button', { name: 'Erbsenmilch' })
		);
		const sheet = await screen.findByRole('dialog', { name: 'Artikel bearbeiten' });
		const name = within(sheet).getByPlaceholderText('Name');
		await fireEvent.input(name, { target: { value: 'Hafermilch' } });
		await fireEvent.blur(name);
		await fireEvent.click(within(sheet).getByRole('button', { name: 'Schließen' }));

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Liste mit 4 Artikeln erstellen' })
		);
		await waitFor(() => expect(importBackup).toHaveBeenCalledTimes(1));
		const [backup] = vi.mocked(importBackup).mock.calls[0];
		expect(backup.items.map((i) => [i.name, i.quantity])).toEqual([
			['Mango', '3'],
			['Paprika, rot', ''],
			['Brot', ''],
			['Hafermilch', '']
		]);
	});

	// [D-254] a file pasted where a list goes.
	it('imports a pasted backup of this app, as a picked file would be', async () => {
		vi.mocked(importListFromFile).mockResolvedValueOnce({ ok: true, id: 'list-b' });
		render(TextImportScreen);
		const backup = JSON.stringify({ format: BACKUP_FORMAT, version: 2, items: [] });
		await fireEvent.input(screen.getByLabelText('Liste als Text'), { target: { value: backup } });

		await fireEvent.click(screen.getByRole('button', { name: 'Backup importieren' }));

		await waitFor(() => expect(importListFromFile).toHaveBeenCalledTimes(1));
		const [source] = vi.mocked(importListFromFile).mock.calls[0];
		expect(await source.text()).toBe(backup);
		await waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith('/list/list-b', expect.anything())
		);
	});

	it.each([
		{
			outcome: { ok: false, reason: 'too_many_items', max: 500, count: 812 } as const,
			message: 'Die Datei hat 812 Artikel, ein Import übernimmt hier höchstens 500.'
		},
		{
			outcome: { ok: false, reason: 'list_limit', max: 25 } as const,
			message:
				'Du bist schon auf 25 Listen, mehr gehen hier nicht. Verlasse eine, um eine neue zu erstellen.'
		},
		{ outcome: { ok: false, reason: 'invalid' } as const, message: 'Ungültige Backup-Datei' },
		{
			outcome: { ok: false, reason: 'failed', error: new Error('500') } as const,
			message: 'Import fehlgeschlagen'
		}
	])(
		'says why a backup was refused ($outcome.reason), and keeps the text',
		async ({ outcome, message }) => {
			vi.mocked(importListFromFile).mockResolvedValueOnce(outcome);
			render(TextImportScreen);
			const backup = JSON.stringify({ format: BACKUP_FORMAT, version: 2, items: [] });
			await fireEvent.input(screen.getByLabelText('Liste als Text'), { target: { value: backup } });

			await fireEvent.click(screen.getByRole('button', { name: 'Backup importieren' }));

			expect((await screen.findByRole('alert')).textContent).toBe(message);
			expect(screen.getByLabelText<HTMLTextAreaElement>('Liste als Text').value).toBe(backup);
			expect(screen.getByRole('button', { name: 'Backup importieren' })).toHaveProperty(
				'disabled',
				false
			);
			expect(goto).not.toHaveBeenCalled();
		}
	);

	it('names a CSV file instead of making an item of every row', async () => {
		render(TextImportScreen);
		await fireEvent.input(screen.getByLabelText('Liste als Text'), {
			target: { value: 'Amount , Unit , Food\nGemüse,,\n2,,Äpfel' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

		expect((await screen.findByRole('alert')).textContent).toContain('CSV-Datei');
		expect(document.querySelector('[data-import-row]')).toBeNull();
	});

	// [D-304] Opened from a list, the list's app bar ‹ is the way back: in the
	// review it goes back to the text, before it to the list.
	it("hands the review's way back to the list's app bar", async () => {
		render(TextImportScreen, { listId: 'list-a' });
		expect(subScreen.step).toBeUndefined();
		await fireEvent.input(screen.getByLabelText('Liste als Text'), {
			target: { value: 'Mango\nBrot' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
		await screen.findByRole('checkbox', { name: 'Mango' });

		subScreen.step!();

		expect(await screen.findByLabelText('Liste als Text')).toBeDefined();
		expect(subScreen.step).toBeUndefined();
	});

	it('sends a backup pasted into a list to the home screen', async () => {
		render(TextImportScreen, { listId: 'list-a' });
		await fireEvent.input(screen.getByLabelText('Liste als Text'), {
			target: { value: JSON.stringify({ format: BACKUP_FORMAT, version: 2 }) }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

		expect((await screen.findByRole('alert')).textContent).toContain('Liste importieren');
		expect(importListFromFile).not.toHaveBeenCalled();
	});

	it('says so when the text holds no item', async () => {
		render(TextImportScreen);

		await fireEvent.input(screen.getByLabelText('Liste als Text'), {
			target: { value: '[Obst]\n\n[Backwaren]' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

		expect((await screen.findByRole('alert')).textContent).toBe(
			'In diesem Text ist kein Artikel zu erkennen.'
		);
	});
});
