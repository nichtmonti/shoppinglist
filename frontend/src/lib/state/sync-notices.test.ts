// The sync notices' copy (§12.2 one-liners). formatConflict reads the row from
// ITS collection, so a list_categories conflict names the category and
// attributes the change to the roster member who made it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const syncMocks = vi.hoisted(() => ({ refreshRoster: vi.fn(), showNotice: vi.fn() }));

vi.mock('#lib/sync/roster.js', () => ({ refreshRoster: syncMocks.refreshRoster }));
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({
		showNotice: syncMocks.showNotice
	})
);

import { db, type Item, type ListCategory } from '#lib/db.js';
import { t } from '#lib/i18n/index.js';
import { formatConflict, formatDenied, formatGone, noticeToasts } from './sync-notices';
import type { ConflictNotice, SyncCollection } from '#lib/sync/types.js';

describe('formatConflict', () => {
	const listId = 'list-1';

	beforeEach(async () => {
		await Promise.all([
			db.items.clear(),
			db.list_categories.clear(),
			db.lists.clear(),
			db.memberships.clear(),
			db.roster.clear()
		]);
	});

	async function seedCategory(overrides: Partial<ListCategory> = {}): Promise<ListCategory> {
		const cat: ListCategory = {
			id: crypto.randomUUID(),
			list: listId,
			slug: null,
			name: 'Obst & Gemüse',
			icon: 'apple',
			color: '#22c55e',
			sort_order: 0,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null,
			...overrides
		};
		await db.list_categories.put(cat);
		return cat;
	}

	async function seedItem(overrides: Partial<Item> = {}): Promise<Item> {
		const item: Item = {
			id: crypto.randomUUID(),
			list: listId,
			name: 'Milch',
			quantity: '1',
			note: null,
			category_key: null,
			checked: false,
			checked_at: null,
			last_bought_at: null,
			name_de: null,
			name_en: null,
			barcode: null,
			image_url: null,
			modified_by: null,
			updated: '2026-01-01T00:00:00.000Z',
			created: '2025-12-01T00:00:00.000Z',
			deleted_at: null,
			...overrides
		};
		await db.items.put(item);
		return item;
	}

	function deletedConflictNotice(collection: SyncCollection, record_id: string): ConflictNotice {
		return {
			kind: 'deleted_conflict',
			collection,
			record_id,
			conflicts: [{ field: 'deleted', mine: false, theirs: true, theirs_by: undefined }]
		};
	}

	it('resolves a CATEGORY notice against list_categories — the name survives', async () => {
		const cat = await seedCategory();
		const msg = await formatConflict(deletedConflictNotice('list_categories', cat.id));
		expect(msg).toContain('Obst & Gemüse');
		expect(msg).not.toContain('""');
	});

	it('resolves an ITEM notice against items', async () => {
		const item = await seedItem();
		const msg = await formatConflict(deletedConflictNotice('items', item.id));
		expect(msg).toContain('Milch');
	});

	it('a category notice for an unknown id degrades to the empty-name copy (no items-table hit)', async () => {
		const msg = await formatConflict(
			deletedConflictNotice('list_categories', 'cat-does-not-exist')
		);
		// No throw, no wrong-table resolution — just the graceful fallback.
		expect(typeof msg).toBe('string');
		expect(msg.length).toBeGreaterThan(0);
	});

	// §8.4's lost-edit one-liner: who won, which field, and the value that stands.
	function partialNotice(record_id: string, field: string, theirs_by?: string): ConflictNotice {
		return {
			kind: 'partial',
			collection: 'items',
			record_id,
			conflicts: [{ field, mine: '2', theirs: '3', theirs_by }]
		};
	}

	async function seedMember(account: string, nickname: string): Promise<void> {
		await db.roster.put({
			id: `${listId}_${account}`,
			list: listId,
			account,
			nickname,
			joined: '2026-01-01T00:00:00.000Z'
		});
	}

	it('a lost field names the winner from the roster, the field and the value that stands', async () => {
		const item = await seedItem();
		await seedMember('acc-anna', 'Anna');
		const msg = await formatConflict(partialNotice(item.id, 'quantity', 'acc-anna'));
		expect(msg).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: 'Anna',
				field: t('sync_field_quantity'),
				theirs: '3'
			})
		);
	});

	// An account may have no nickname (an OIDC provider that sent no name).
	it('a known member without a nickname reads as the member placeholder, without a refresh', async () => {
		syncMocks.refreshRoster.mockClear();
		const item = await seedItem();
		await seedMember('acc-anon', '');
		const msg = await formatConflict(partialNotice(item.id, 'quantity', 'acc-anon'));
		expect(syncMocks.refreshRoster).not.toHaveBeenCalled();
		expect(msg).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: t('member_unnamed'),
				field: t('sync_field_quantity'),
				theirs: '3'
			})
		);
	});

	it("an author the roster does not know refreshes it once (§7.4's on-miss trigger), then says 'someone'", async () => {
		syncMocks.refreshRoster.mockClear();
		const item = await seedItem();
		const msg = await formatConflict(partialNotice(item.id, 'note', 'acc-gone'));
		expect(syncMocks.refreshRoster).toHaveBeenCalledExactlyOnceWith(listId);
		expect(msg).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: t('common_someone'),
				field: t('sync_field_note'),
				theirs: '3'
			})
		);
	});

	it("a cleared author (a deleted account, [D-32]) is 'someone' without a roster round-trip", async () => {
		syncMocks.refreshRoster.mockClear();
		const item = await seedItem();
		const msg = await formatConflict(partialNotice(item.id, 'name'));
		expect(syncMocks.refreshRoster).not.toHaveBeenCalled();
		expect(msg).toContain(t('common_someone'));
	});

	it('a field without its own copy falls back to the generic field name', async () => {
		const item = await seedItem();
		await seedMember('acc-anna', 'Anna');
		const msg = await formatConflict(partialNotice(item.id, 'barcode', 'acc-anna'));
		expect(msg).toContain(t('sync_field_generic'));
	});

	it("a merged create names the row and keeps the first adder's quantity", async () => {
		const item = await seedItem({ quantity: '1' });
		await seedMember('acc-anna', 'Anna');
		const msg = await formatConflict({
			kind: 'merged',
			collection: 'items',
			record_id: item.id,
			conflicts: [{ field: 'quantity', mine: '2', theirs: '1', theirs_by: 'acc-anna' }]
		});
		expect(msg).toBe(t('sync_conflict_merged', { name: 'Milch', who: 'Anna', theirs: '1' }));
	});

	// The server reports every differing field, and a re-add always carries its
	// auto-classified aisle — so the quantity is not necessarily first, and the
	// merged copy (which speaks of a quantity) must not be given another field.
	it('a merged create reports the quantity whatever order the conflicts arrive in', async () => {
		const item = await seedItem({ quantity: '1' });
		await seedMember('acc-anna', 'Anna');
		const msg = await formatConflict({
			kind: 'merged',
			collection: 'items',
			record_id: item.id,
			conflicts: [
				{ field: 'category_key', mine: 'dairy', theirs: 'drinks', theirs_by: 'acc-anna' },
				{ field: 'quantity', mine: '2', theirs: '1', theirs_by: 'acc-anna' }
			]
		});
		expect(msg).toBe(t('sync_conflict_merged', { name: 'Milch', who: 'Anna', theirs: '1' }));
	});

	// The value that stands as the user knows it, never a row id or a boolean.
	it('names a category by its name, a tick in words, and a cleared value as cleared', async () => {
		const item = await seedItem();
		const fruit = await seedCategory({ name: 'Obst & Gemüse' });
		await seedMember('acc-anna', 'Anna');
		const lost = (field: string, theirs: unknown) =>
			formatConflict({
				kind: 'partial',
				collection: 'items',
				record_id: item.id,
				conflicts: [{ field, mine: 'x', theirs, theirs_by: 'acc-anna' }]
			});
		expect(await lost('category_key', fruit.id)).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: 'Anna',
				field: t('sync_field_category_key'),
				theirs: 'Obst & Gemüse'
			})
		);
		expect(await lost('checked', true)).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: 'Anna',
				field: t('sync_field_checked'),
				theirs: t('sync_value_checked')
			})
		);
		expect(await lost('note', null)).toBe(
			t('sync_conflict_cleared_named', { name: 'Milch', who: 'Anna', field: t('sync_field_note') })
		);
	});

	it('shows the quantity, then the name, before the aisle a re-add reports', async () => {
		const item = await seedItem();
		await seedMember('acc-anna', 'Anna');
		const msg = await formatConflict({
			kind: 'partial',
			collection: 'items',
			record_id: item.id,
			conflicts: [
				{ field: 'category_key', mine: 'a', theirs: 'b', theirs_by: 'acc-anna' },
				{ field: 'note', mine: 'bio', theirs: 'frisch', theirs_by: 'acc-anna' }
			]
		});
		expect(msg).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: 'Anna',
				field: t('sync_field_note'),
				theirs: 'frisch'
			})
		);
	});

	// A quantity someone deliberately cleared is said in words, in an edit
	// conflict and in a merge, never quoted as „“.
	it('a cleared quantity reads as removed, never as an empty quote', async () => {
		const item = await seedItem();
		await seedMember('acc-anna', 'Anna');
		const cleared = t('sync_conflict_cleared_named', {
			name: 'Milch',
			who: 'Anna',
			field: t('sync_field_quantity')
		});
		for (const kind of ['partial', 'merged'] as const) {
			const msg = await formatConflict({
				kind,
				collection: 'items',
				record_id: item.id,
				conflicts: [{ field: 'quantity', mine: '3 Stück', theirs: '', theirs_by: 'acc-anna' }]
			});
			expect(msg, kind).toBe(cleared);
		}
	});

	it('a merged create without a quantity conflict names the field it kept', async () => {
		const item = await seedItem();
		await seedMember('acc-anna', 'Anna');
		const msg = await formatConflict({
			kind: 'merged',
			collection: 'items',
			record_id: item.id,
			conflicts: [{ field: 'note', mine: 'bio', theirs: 'frisch', theirs_by: 'acc-anna' }]
		});
		expect(msg).toBe(
			t('sync_conflict_field_named', {
				name: 'Milch',
				who: 'Anna',
				field: t('sync_field_note'),
				theirs: 'frisch'
			})
		);
	});
});

// §8.3 `denied` [D-40]: the reason decides the copy, and no wire code leaks.
describe('formatDenied', () => {
	const denied = (
		reason?: string,
		field?: string,
		collection: 'items' | 'list_categories' = 'items'
	) => ({
		collection,
		record_id: 'item-1',
		list_id: 'list-1',
		reason,
		field
	});

	it('too long names the field', () => {
		expect(formatDenied(denied('field_too_long', 'note'))).toBe(
			t('sync_denied_too_long', { field: t('sync_field_note') })
		);
	});

	it('too long on a field without its own copy uses the generic field name', () => {
		expect(formatDenied(denied('field_too_long', 'barcode'))).toBe(
			t('sync_denied_too_long', { field: t('sync_field_generic') })
		);
	});

	it('the protected Others row has its own line', () => {
		expect(formatDenied(denied('protected_row'))).toBe(t('sync_denied_protected'));
	});

	it('a full list has its own line', () => {
		expect(formatDenied(denied('list_full'))).toBe(t('sync_denied_list_full'));
	});

	it('a list full of categories says so, not that an item was refused', () => {
		expect(formatDenied(denied('list_full', undefined, 'list_categories'))).toBe(
			t('sync_denied_categories_full')
		);
	});

	it('every other reason is one generic line', () => {
		for (const reason of ['not_member', 'field_unknown', 'field_too_long', undefined]) {
			expect(formatDenied(denied(reason))).toBe(t('sync_denied_generic'));
		}
	});
});

// §8.6 `gone`: neutral copy, named when the caller read the name before the
// purge ([D-138]).
describe('formatGone', () => {
	it('names the list', () => {
		expect(formatGone('Wochenshop')).toBe(t('sync_list_gone', { name: 'Wochenshop' }));
	});

	it('a list without a known name still gets a notice', () => {
		expect(formatGone(undefined)).toBe(t('sync_list_gone_unknown'));
	});
});

// [D-293] The loop runs in the leader tab, which may be one the user is not
// looking at: a notice is shown there and in every other tab.
describe('a notice reaches every tab', () => {
	it('is shown here and posted to the other tabs', async () => {
		const otherTab = new BroadcastChannel('sync-notices');
		const received = new Promise<string>((resolve) => {
			otherTab.onmessage = (event: MessageEvent<string>) => resolve(event.data);
		});

		noticeToasts.onGone?.('list-1', 'Wochenshop');

		expect(syncMocks.showNotice).toHaveBeenCalledWith(formatGone('Wochenshop'));
		await expect(received).resolves.toBe(formatGone('Wochenshop'));
		otherTab.close();
	});

	it("shows what another tab's loop raised", async () => {
		syncMocks.showNotice.mockClear();
		const leader = new BroadcastChannel('sync-notices');
		leader.postMessage(formatGone('Getränke'));

		await vi.waitFor(() =>
			expect(syncMocks.showNotice).toHaveBeenCalledWith(formatGone('Getränke'))
		);
		leader.close();
	});
});
