// #lib/actions/lists.ts — with the focus on leaveList, which is the most
// destructive thing a member can do from the UI: it hard-deletes their
// membership row, and the §7.3 last-one-out hook then cascade-deletes the whole
// list server-side. The suite had no test for it at all.
//
// #lib/sync/loop is left REAL: purgeList is half of what leaveList promises
// (§8.6), and asserting against a double would prove nothing about it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	membershipsDelete,
	membershipsUpdate,
	membershipsGetFullList,
	listsUpdate,
	pbSend,
	pbFilter,
	buildListBackup,
	deliverBackup
} = vi.hoisted(() => ({
	membershipsDelete: vi.fn().mockResolvedValue(true),
	membershipsUpdate: vi.fn().mockResolvedValue({}),
	membershipsGetFullList: vi.fn().mockResolvedValue([]),
	listsUpdate: vi.fn().mockResolvedValue({}),
	pbSend: vi.fn().mockResolvedValue({}),
	pbFilter: vi.fn((expr: string) => expr),
	buildListBackup: vi.fn().mockResolvedValue({
		format: 'einkaufsliste/list-backup',
		version: 1,
		exported_at: '2026-08-29T00:00:00.000Z',
		display_name: 'Familie',
		categories: [],
		items: []
	}),
	deliverBackup: vi.fn().mockResolvedValue(true)
}));

vi.mock('#lib/pb.js', async () => {
	const { pbModuleMock } = await import('#lib/test-kit/pb-mock.js');
	return pbModuleMock({
		collections: {
			memberships: {
				delete: membershipsDelete,
				update: membershipsUpdate,
				getFullList: membershipsGetFullList
			},
			// [D-08] a rename writes the lists row; memberships carry no name.
			lists: { update: listsUpdate }
		},
		send: pbSend,
		pb: { filter: pbFilter }
	});
});

vi.mock('#lib/actions/list-backup.js', () => ({ buildListBackup }));

vi.mock('#lib/deliver-backup.js', () => ({ deliverBackup }));

import { db } from '#lib/db.js';
import { wipeLocalAccountData } from '#lib/auth/account-data.js';
import { endSession } from '#lib/auth/session.js';
import {
	makeCategory,
	makeItem,
	makeMembership,
	putMyList,
	resetDb,
	seedList
} from '#lib/test-kit/db.js';
import {
	clearHistory,
	cloneList,
	createList,
	exportList,
	importList,
	importFailureMessage,
	importListFromFile,
	joinList,
	leaveList,
	ListLimitError,
	renameList
} from './lists';
import { ClientResponseError } from 'pocketbase';
import { t } from '#lib/i18n/index.js';
import { updateRecord } from '#lib/sync/outbox.js';
import {
	BACKUP_FORMAT,
	BACKUP_VERSION,
	LIST_LIMIT,
	MAX_BACKUP_ITEMS
} from '#lib/field-contract.js';
import { shadowDivergence } from '#lib/test-kit/shadow-check.js';

// The backup document buildListBackup is stubbed to resolve; importList and
// exportList both flow through it.
const minimalBackup = {
	format: 'einkaufsliste/list-backup',
	version: 1,
	exported_at: '2026-08-29T00:00:00.000Z',
	display_name: 'Familie',
	categories: [],
	items: []
};

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	membershipsDelete.mockResolvedValue(true);
	membershipsUpdate.mockResolvedValue({});
	membershipsGetFullList.mockResolvedValue([]);
	listsUpdate.mockResolvedValue({});
	buildListBackup.mockResolvedValue(minimalBackup);
	deliverBackup.mockResolvedValue(true);
});

describe('leaveList (§7.2)', () => {
	it('deletes the caller’s own membership row and purges the list locally (§8.6)', async () => {
		const own = makeMembership({ id: 'mem-own', list: 'list-1' });
		await db.memberships.put(own);
		await seedList({
			listId: 'list-1',
			items: [makeItem({ list: 'list-1', name: 'Milch' })],
			categories: [makeCategory({ list: 'list-1', slug: 'dairy' })]
		});
		// Re-put the membership: seedList writes its own row for the same list.
		await db.memberships.clear();
		await db.memberships.put(own);
		await db.roster.put({
			id: 'list-1_account-1',
			list: 'list-1',
			account: 'account-1',
			nickname: 'Ich',
			joined: '2026-01-01T00:00:00.000Z'
		});
		await db.pending_ops.put({
			op_id: 'op-1',
			collection: 'items',
			record_id: 'item-x',
			list_id: 'list-1',
			type: 'update',
			changed: { name: 'Milch' },
			base: {},
			queued_at: '2026-01-01T00:00:00.000Z'
		});
		// A second list must survive untouched — the purge is per-list.
		await seedList({ listId: 'list-2', items: [makeItem({ list: 'list-2', name: 'Brot' })] });

		await leaveList('list-1');

		expect(membershipsDelete).toHaveBeenCalledWith('mem-own');
		expect(await db.memberships.where('list').equals('list-1').count()).toBe(0);
		expect(await db.items.where('list').equals('list-1').count()).toBe(0);
		expect(await db.list_categories.where('list').equals('list-1').count()).toBe(0);
		expect(await db.roster.where('list').equals('list-1').count()).toBe(0);
		expect(await db.lists.get('list-1')).toBeUndefined();
		// Queued ops for a list you just left must not be pushed afterwards.
		expect(await db.pending_ops.where('list_id').equals('list-1').count()).toBe(0);

		expect(await db.items.where('list').equals('list-2').count()).toBe(1);
		expect(await db.lists.get('list-2')).toBeDefined();
	});

	it('falls back to the server for the membership id when Dexie has no local row', async () => {
		membershipsGetFullList.mockResolvedValueOnce([{ id: 'mem-server' }]);

		await leaveList('list-1');

		expect(membershipsGetFullList).toHaveBeenCalled();
		expect(membershipsDelete).toHaveBeenCalledWith('mem-server');
	});

	it('still purges locally when neither Dexie nor the server knows the membership', async () => {
		await seedList({ listId: 'list-1', items: [makeItem({ list: 'list-1', name: 'Milch' })] });
		await db.memberships.clear();

		await leaveList('list-1');

		expect(membershipsDelete).not.toHaveBeenCalled();
		expect(await db.items.where('list').equals('list-1').count()).toBe(0);
	});

	// [D-293] The first try's response was lost: the membership is gone.
	it('counts a membership already gone as left, and purges', async () => {
		await seedList({ listId: 'list-1', items: [makeItem({ list: 'list-1', name: 'Milch' })] });
		membershipsDelete.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));

		await leaveList('list-1');

		expect(await db.items.where('list').equals('list-1').count()).toBe(0);
	});

	it('leaves the local copy alone when the server refuses the delete', async () => {
		await seedList({ listId: 'list-1', items: [makeItem({ list: 'list-1', name: 'Milch' })] });
		membershipsDelete.mockRejectedValueOnce(new Error('offline'));

		await expect(leaveList('list-1')).rejects.toThrow('offline');
		// Online-only ([D-09]): a failed leave must not destroy the local list.
		expect(await db.items.where('list').equals('list-1').count()).toBe(1);
		expect(await db.memberships.where('list').equals('list-1').count()).toBe(1);
	});
});

describe('renameList (§6.4 [D-08] — the list’s one name)', () => {
	it('updates the lists row server-side and writes the new name to the local list row', async () => {
		await putMyList('list-1', 'Alt', { id: 'mem-own', updated: '2026-07-01T00:00:00.000Z' });
		const memberBefore = await db.memberships.get('mem-own');

		await renameList('list-1', 'Neu');

		expect(listsUpdate).toHaveBeenCalledWith('list-1', { name: 'Neu' });
		// No membership write at all: the name is not the member's any more.
		expect(membershipsUpdate).not.toHaveBeenCalled();
		const list = await db.lists.get('list-1');
		expect(list?.name).toBe('Neu');
		// `updated` is the digest's max_updated (§9.3 ordering) — a rename must not move it.
		expect(list?.updated).toBe('2026-07-01T00:00:00.000Z');
		expect(await db.memberships.get('mem-own')).toEqual(memberBefore);
	});

	it('leaves the local name alone when the server refuses the rename', async () => {
		await putMyList('list-1', 'Alt');
		listsUpdate.mockRejectedValueOnce(new Error('offline'));

		await expect(renameList('list-1', 'Neu')).rejects.toThrow('offline');
		expect((await db.lists.get('list-1'))?.name).toBe('Alt');
	});

	// [D-109]: a sign-out during the request has wiped the mirror; the late
	// response must not write the previous account's list back.
	it('writes nothing back when the session ended during the request', async () => {
		await putMyList('list-1', 'Alt', { id: 'mem-own' });
		listsUpdate.mockImplementationOnce(async () => {
			endSession();
			await wipeLocalAccountData();
			return {};
		});

		await renameList('list-1', 'Neu');

		expect(await db.lists.get('list-1')).toBeUndefined();
		expect(await db.memberships.get('mem-own')).toBeUndefined();
	});
});

describe('createList (§7.5 [D-08])', () => {
	it('posts the list name and resolves to the server-minted id', async () => {
		pbSend.mockResolvedValueOnce({ id: 'server-minted-0' });

		const id = await createList('Wocheneinkauf');

		expect(pbSend).toHaveBeenCalledWith('/api/lists', {
			method: 'POST',
			body: { name: 'Wocheneinkauf' }
		});
		expect(id).toBe('server-minted-0');
	});
});

describe('joinList (§7.6 [D-08])', () => {
	it('sends only the token — the joiner sees the list’s own name', async () => {
		pbSend.mockResolvedValueOnce({ id: 'mem-new', list: 'list-9' });

		const listId = await joinList('tok-123');

		expect(pbSend).toHaveBeenCalledWith('/api/invites/join', {
			method: 'POST',
			body: { token: 'tok-123' }
		});
		expect(listId).toBe('list-9');
	});
});

// [D-219] The three list-making routes share one 409 for the lists cap; the
// action turns it into a ListLimitError whose message is the user's copy.
describe('the lists cap ([D-219])', () => {
	const limit = () =>
		new ClientResponseError({
			status: LIST_LIMIT.status,
			response: { code: LIST_LIMIT.code, max: 25 }
		});

	it('create rejects with a ListLimitError naming the cap', async () => {
		pbSend.mockRejectedValueOnce(limit());
		const err = await createList('Neu').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ListLimitError);
		expect((err as ListLimitError).max).toBe(25);
		expect((err as Error).message).toBe(t('home_list_limit', { max: 25 }));
	});

	it('clone does the same', async () => {
		pbSend.mockRejectedValueOnce(limit());
		await expect(cloneList('list-1', 'Kopie')).rejects.toBeInstanceOf(ListLimitError);
	});

	it('an import at the cap reports list_limit with the cap', async () => {
		pbSend.mockRejectedValueOnce(limit());
		const file = {
			text: () =>
				Promise.resolve(
					JSON.stringify({ ...minimalBackup, format: BACKUP_FORMAT, version: BACKUP_VERSION })
				)
		};
		expect(await importListFromFile(file, 'x')).toEqual({
			ok: false,
			reason: 'list_limit',
			max: 25
		});
	});

	it('any other 409 is rethrown as it came', async () => {
		const other = new ClientResponseError({ status: 409, response: { message: 'conflict' } });
		pbSend.mockRejectedValueOnce(other);
		await expect(createList('Neu')).rejects.toBe(other);
	});
});

describe('cloneList (§7.5 [D-72])', () => {
	it('sends the name and no id, and resolves to the one the server minted', async () => {
		pbSend.mockResolvedValueOnce({ id: 'server-minted-1' });

		const id = await cloneList('list-1', 'Kopie');

		expect(pbSend).toHaveBeenCalledWith(
			'/api/lists/list-1/clone',
			expect.objectContaining({ method: 'POST' })
		);
		const [, options] = pbSend.mock.calls[0];
		// [D-08]: the server mints the id; the name is always the client's.
		expect(options.body).toEqual({ name: 'Kopie' });
		expect(id).toBe('server-minted-1');
	});
});

describe('importList (§7.5 [D-72])', () => {
	it('posts the name and the backup with no id and resolves to the server-minted one', async () => {
		pbSend.mockResolvedValueOnce({ id: 'server-minted-2' });

		const id = await importList(minimalBackup, 'X');

		expect(pbSend).toHaveBeenCalledWith(
			'/api/lists/import',
			expect.objectContaining({ method: 'POST' })
		);
		const [, options] = pbSend.mock.calls[0];
		expect(options.body).toEqual({ name: 'X', backup: minimalBackup });
		expect(id).toBe('server-minted-2');
	});
});

describe('importListFromFile', () => {
	const fileOf = (doc: object) => ({
		text: () =>
			Promise.resolve(JSON.stringify({ ...doc, format: BACKUP_FORMAT, version: BACKUP_VERSION }))
	});

	it("imports under the file's list name", async () => {
		pbSend.mockResolvedValueOnce({ id: 'imported-1' });

		const outcome = await importListFromFile(fileOf(minimalBackup), 'Importierte Liste');

		expect(outcome).toEqual({ ok: true, id: 'imported-1' });
		expect(pbSend.mock.calls[0][1].body.name).toBe('Familie');
	});

	it('falls back to the given name when the file carries none', async () => {
		pbSend.mockResolvedValueOnce({ id: 'imported-2' });

		await importListFromFile(fileOf({ ...minimalBackup, display_name: '  ' }), 'Imported list');

		expect(pbSend.mock.calls[0][1].body.name).toBe('Imported list');
	});

	it('reports a file that is not a backup as invalid, without a request', async () => {
		expect(await importListFromFile({ text: () => Promise.resolve('{') }, 'x')).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(await importListFromFile(fileOf({ items: 'none' }), 'x')).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('reports a file over the import cap with its numbers, without a request ([D-217])', async () => {
		const item = {
			name: 'x',
			quantity: '',
			note: null,
			category_key: null,
			barcode: null,
			image_url: null
		};
		const items = Array.from({ length: MAX_BACKUP_ITEMS + 1 }, () => item);
		expect(await importListFromFile(fileOf({ ...minimalBackup, items }), 'x')).toEqual({
			ok: false,
			reason: 'too_many_items',
			max: MAX_BACKUP_ITEMS,
			count: MAX_BACKUP_ITEMS + 1
		});
		expect(pbSend).not.toHaveBeenCalled();
	});

	it('reports a refused import as failed', async () => {
		const refused = new Error('400');
		pbSend.mockRejectedValueOnce(refused);

		expect(await importListFromFile(fileOf(minimalBackup), 'x')).toEqual({
			ok: false,
			reason: 'failed',
			error: refused
		});
	});
});

describe('importFailureMessage', () => {
	it('says what each refusal means, with its numbers', () => {
		expect(importFailureMessage({ ok: false, reason: 'invalid' })).toBe(t('home_import_invalid'));
		const failed = (error: unknown) => importFailureMessage({ ok: false, reason: 'failed', error });
		expect(failed(Object.assign(new Error('x'), { status: 500 }))).toBe(t('home_import_failed'));
		// [D-293] What the user can act on is said: no connection, the session.
		expect(failed(Object.assign(new Error('x'), { status: 0 }))).toBe(t('common_error_connection'));
		expect(failed(Object.assign(new Error('x'), { status: 401 }))).toBe(t('common_error_session'));
		expect(importFailureMessage({ ok: false, reason: 'list_limit', max: 25 })).toBe(
			t('home_list_limit', { max: 25 })
		);
		expect(
			importFailureMessage({ ok: false, reason: 'too_many_items', max: 500, count: 501 })
		).toBe(t('home_import_too_many_items', { max: 500, count: 501 }));
	});
});

describe('exportList (§7.5 [D-72])', () => {
	it('builds the backup from the local mirror and downloads it', async () => {
		await exportList('list-1');

		expect(buildListBackup).toHaveBeenCalledWith('list-1');
		expect(deliverBackup).toHaveBeenCalledWith(minimalBackup);
	});
});

describe('clearHistory (§6.10 [D-79])', () => {
	it('posts to the clear-history route, nulls the local stamps, and resolves the cleared count', async () => {
		await seedList({
			listId: 'list-1',
			items: [
				makeItem({
					list: 'list-1',
					name: 'Milch',
					checked: true,
					checked_at: '2026-01-01T00:00:00.000Z',
					last_bought_at: '2026-01-01T00:00:00.000Z'
				}),
				makeItem({ list: 'list-1', name: 'Brot' })
			]
		});
		// A second list's stamps must survive — the settle is per-list.
		await seedList({
			listId: 'list-2',
			items: [
				makeItem({
					list: 'list-2',
					name: 'Käse',
					checked: true,
					checked_at: '2026-01-01T00:00:00.000Z',
					last_bought_at: '2026-01-01T00:00:00.000Z'
				})
			]
		});
		pbSend.mockResolvedValueOnce({ cleared: 3 });

		const cleared = await clearHistory('list-1');

		expect(pbSend).toHaveBeenCalledWith(
			'/api/lists/list-1/clear-history',
			expect.objectContaining({ method: 'POST' })
		);
		expect(cleared).toBe(3);
		const rows = await db.items.where('list').equals('list-1').toArray();
		expect(rows.map((i) => i.checked_at)).toEqual([null, null]);
		expect(rows.map((i) => i.last_bought_at)).toEqual([null, null]);
		const other = await db.items.where('list').equals('list-2').toArray();
		expect(other[0].checked_at).toBe('2026-01-01T00:00:00.000Z');
		// A direct local mirror write — never an outbox op.
		expect(await db.pending_ops.count()).toBe(0);
		expect(
			(await db.server_items.where('list').equals('list-1').toArray()).map((i) => i.checked_at)
		).toEqual([null, null]);
	});

	it('leaves a check-off still queued here showing its own stamps — the server has not seen it yet', async () => {
		// Writing the rows directly would leave `checked: true` with a null
		// `checked_at`, a row in neither the active list nor the done pile.
		const milk = makeItem({ list: 'list-1', name: 'Milch' });
		await seedList({ listId: 'list-1', items: [milk] });
		const now = '2026-10-03T10:00:00.000Z';
		await updateRecord(
			'items',
			milk,
			{ checked: true },
			{ stamps: { checked_at: now, last_bought_at: now } }
		);
		pbSend.mockResolvedValueOnce({ cleared: 0 });

		await clearHistory('list-1');

		expect(await db.items.get(milk.id)).toMatchObject({ checked: true, checked_at: now });
		expect(await shadowDivergence()).toEqual([]);
	});
});
