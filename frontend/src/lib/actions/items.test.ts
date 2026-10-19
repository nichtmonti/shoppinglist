// #lib/actions/items.ts — the module every shared item mutation goes through.
// The focus
// is `removeItem` and the re-add path, because §6.10 keeps NO separate history
// record: "what was previously on this list" IS the `items` row, so what a
// remove does to that row is what it does to the household's memory.
//
// The outbox is left REAL. The whole claim under test is about op shape —
// which fields ride, and that a restore plus an uncheck coalesce into ONE op —
// and a double would prove nothing about that. Only `showToast` is stubbed, so
// the undo callback can be captured and invoked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({ showToast })
);

import { liveQuery } from 'dexie';
import { db, type Item } from '#lib/db.js';
import { t } from '#lib/i18n/index.js';
import { previousItems } from '#lib/sorting.js';
import { makeItem, putSynced, resetDb } from '#lib/test-kit/db.js';
import {
	addImported,
	addItemWithUndo,
	applyDedupHit,
	editItem,
	reactivate,
	removeItem,
	toggleChecked
} from './items';

const LIST = 'list-1';
const BOUGHT = '2026-09-08T10:00:00.000Z';

async function seed(overrides: Partial<Item> & { name: string }): Promise<Item> {
	const item = makeItem({ list: LIST, ...overrides });
	await putSynced([item]);
	return item;
}

async function opFor(id: string) {
	const ops = await db.pending_ops.where('record_id').equals(id).toArray();
	return ops;
}

/** The undo handed to the most recent toast. */
function lastUndo(): () => Promise<void> {
	const call = showToast.mock.calls.at(-1);
	expect(call?.[1]).toBeTypeOf('function');
	return call![1] as () => Promise<void>;
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
});

// [D-21]: a rename is one name for everyone — it clears a scanned item's
// localized names in the SAME op, so the server settles them together.
describe('editItem on a scanned item', () => {
	const localized = {
		name: 'Pâte à tartiner',
		name_de: 'Nuss-Nougat-Creme',
		name_en: 'Hazelnut spread'
	};

	it('clears the localized names in the rename op', async () => {
		const item = await seed(localized);

		await editItem(item, { name: 'Nutella' });

		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({
				type: 'update',
				changed: { name: 'Nutella', name_de: null, name_en: null },
				base: { name: 'Pâte à tartiner', name_de: 'Nuss-Nougat-Creme', name_en: 'Hazelnut spread' }
			})
		]);
		const stored = await db.items.get(item.id);
		expect([stored?.name, stored?.name_de, stored?.name_en]).toEqual(['Nutella', null, null]);
	});

	it('clears them even when the new name equals the stored one', async () => {
		// The renamer saw "Nuss-Nougat-Creme" and typed the product's main name.
		const item = await seed(localized);

		await editItem(item, { name: 'Pâte à tartiner' });

		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ changed: { name_de: null, name_en: null } })
		]);
	});

	it('leaves them alone when something other than the name changes', async () => {
		const item = await seed(localized);

		await editItem(item, { quantity: '2' });

		expect(await opFor(item.id)).toEqual([expect.objectContaining({ changed: { quantity: '2' } })]);
	});
});

describe('removeItem', () => {
	it('tombstones a row that was never bought, and says it is gone', async () => {
		const item = await seed({ name: 'Servietten' });

		await removeItem(item);

		expect((await db.items.get(item.id))?.deleted_at).not.toBeNull();
		// The KEY is the assertion, not the copy — this suite runs in the default
		// locale, and which of the two messages fires is the behaviour under test.
		expect(showToast.mock.calls[0][0]).toBe(t('history_toast_removed', { name: 'Servietten' }));
		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ type: 'update', changed: { deleted: true } })
		]);
	});

	it('tombstones a remembered row too, but says it stays in previous items', async () => {
		// Same write — what differs is what the tombstone MEANS (§6.10), so the
		// only observable difference is the copy. One gesture, two outcomes.
		const item = await seed({ name: 'Haselnussmus', last_bought_at: BOUGHT });

		await removeItem(item);

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).not.toBeNull();
		expect(row?.last_bought_at).toBe(BOUGHT);
		expect(showToast.mock.calls[0][0]).toBe(
			t('history_toast_removed_kept', { name: 'Haselnussmus' })
		);
		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ type: 'update', changed: { deleted: true } })
		]);
	});

	it('undo restores the row and leaves the purchase date alone', async () => {
		const item = await seed({ name: 'Haselnussmus', last_bought_at: BOUGHT });
		await removeItem(item);

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).toBeNull();
		expect(row?.last_bought_at).toBe(BOUGHT);
	});
});

// §9.1: every tile tap raises an undo toast, and the undo is an uncheck.
describe('toggleChecked', () => {
	it('undo before the check was sent leaves nothing to push', async () => {
		const item = await seed({ name: 'Milch' });
		await toggleChecked(item);
		expect(showToast.mock.calls[0][0]).toBe(t('history_toast_checked', { name: 'Milch' }));

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.checked).toBe(false);
		expect(row?.checked_at).toBeNull();
		expect(await opFor(item.id)).toEqual([]);
	});

	it('undo after the check settled queues the uncheck', async () => {
		const item = await seed({ name: 'Milch' });
		await toggleChecked(item);
		// The push drained and the server's record came back, stamps and all.
		const stamp = '2026-10-10T08:00:00.000Z';
		await db.pending_ops.clear();
		await putSynced([{ ...item, checked: true, checked_at: stamp, last_bought_at: stamp }]);

		await lastUndo()();

		// Not bought after all: the server restores the date the tick replaced
		// (none here), and the row shows it at once ([D-26]).
		const row = await db.items.get(item.id);
		expect(row?.checked).toBe(false);
		expect(row?.last_bought_at).toBeNull();
		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ type: 'update', changed: { checked: false, bought: false } })
		]);
	});

	it('puts an item back from the done pile as not bought', async () => {
		const item = await seed({
			name: 'Milch',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});
		await toggleChecked(item);
		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ changed: { checked: false, bought: false } })
		]);
	});
});

describe('reactivate', () => {
	it('re-adds a checked row: clears checked/checked_at, keeps last_bought_at', async () => {
		const item = await seed({
			name: 'Kaffee',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});

		await reactivate(item);

		const row = await db.items.get(item.id);
		expect(row?.checked).toBe(false);
		expect(row?.checked_at).toBeNull();
		expect(row?.last_bought_at).toBe(BOUGHT);
		// Bought, and needed again: no "not bought" for the server ([D-26]).
		const [op] = await opFor(item.id);
		expect(op?.changed).not.toHaveProperty('bought');
	});

	it('lifts the tombstone of a remembered row in ONE coalesced op', async () => {
		// Re-adding from "Frühere Artikel" has to reach rows that were REMOVED
		// rather than checked off. Two calls, one op: the outbox keys
		// pending ops on (collection, record_id), and the push route applies
		// `{deleted:false, checked:false}` in a single pass.
		const item = await seed({
			name: 'Haselnussmus',
			checked: false,
			checked_at: null,
			last_bought_at: BOUGHT,
			deleted_at: '2026-09-09T09:00:00.000Z'
		});

		await reactivate(item);

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).toBeNull();
		expect(row?.checked).toBe(false);
		expect(row?.last_bought_at).toBe(BOUGHT);
		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ changed: { deleted: false, checked: false } })
		]);
	});

	it('undoing that re-add removes it again WITHOUT recording a purchase', async () => {
		// The trap this pins: reversing a re-add by re-CHECKING the row would
		// stamp last_bought_at = now (§6.6) and record a purchase that never
		// happened. Only a row that was actually checked gets re-checked.
		const item = await seed({
			name: 'Haselnussmus',
			checked: false,
			checked_at: null,
			last_bought_at: BOUGHT,
			deleted_at: '2026-09-09T09:00:00.000Z'
		});
		await reactivate(item);

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).not.toBeNull();
		expect(row?.checked).toBe(false);
		expect(row?.last_bought_at).toBe(BOUGHT);
	});

	it('undoing a re-add from PREVIOUS items puts the row back and keeps the old purchase date', async () => {
		// The row a previous-items tap actually lands on: LIVING, checked, stamps
		// from a previous trip — bought last trip, never removed. The old undo
		// re-checked it, and a re-check stamps checked_at = last_bought_at = now
		// server-side ([D-26]), stranding the article in the done section at the
		// bottom of the shop view with a corrupted purchase date instead of
		// returning it to "Frühere Artikel" — the reported bug.
		const item = await seed({
			name: 'Kaffee',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});
		await reactivate(item);

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).not.toBeNull();
		// NOT now: the remembered purchase date survives the whole add+undo
		// round trip — the tombstone is the one inverse that never touches it.
		expect(row?.last_bought_at).toBe(BOUGHT);
		// And it is §6.10 history again — a remembered tombstone re-enters
		// previous items immediately (removed rows skip the trip), at its
		// old position because the stamp is still the old one.
		expect(previousItems([row!]).map((i) => i.name)).toEqual(['Kaffee']);
		// The re-add's {checked:false} and the undo's {deleted:true} coalesced
		// into one op, exactly like the two-move re-add itself does.
		expect(await opFor(item.id)).toEqual([
			expect.objectContaining({ type: 'update', changed: { checked: false, deleted: true } })
		]);
	});

	it('undoing a re-add of a remembered tombstone that was CHECKED keeps the old purchase date too', async () => {
		// Removed while checked (bought, then trashed without unchecking). The
		// old undo re-checked before re-tombstoning — the same stamp
		// corruption with a milder symptom: the row returned to "Frühere
		// Artikel" but sorted to the top as "heute".
		const item = await seed({
			name: 'Tee',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT,
			deleted_at: '2026-09-09T09:00:00.000Z'
		});
		await reactivate(item);

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).not.toBeNull();
		expect(row?.last_bought_at).toBe(BOUGHT);
		expect(previousItems([row!]).map((i) => i.name)).toEqual(['Tee']);
	});

	it('undoing a restore from THIS trip re-checks it — the purchase was today', async () => {
		// The done-section / fresh dedup-hit population: checked on the list's
		// current trip ([D-18]). Re-checking re-records today's purchase — the one
		// branch where the now-stamp is not corruption, because today is when
		// the purchase actually happened.
		const trip = new Date().toISOString();
		const item = await seed({
			name: 'Milch',
			checked: true,
			checked_at: trip,
			last_bought_at: trip
		});
		await reactivate(item);
		expect((await db.items.get(item.id))?.checked).toBe(false);

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.checked).toBe(true);
		expect(row?.deleted_at).toBeNull();
		expect(row?.checked_at).not.toBeNull();
		expect(row?.last_bought_at).not.toBeNull();
	});
});

describe('applyDedupHit', () => {
	it('lifts a remembered UNCHECKED tombstone instead of jumping at a row that renders nowhere', async () => {
		// The state a re-add-then-undo leaves behind (and removeItem of a
		// re-added row): tombstoned, remembered, unchecked. `findByName`
		// returns exactly this row, and the jump branch would claim "schon auf
		// der Liste" while nothing is on the list and the jump itself no-ops.
		// It is the SAME intent as the
		// checked case: "Add X" means X on the list, whatever X's row was
		// doing in §6.10 beforehand.
		const item = await seed({
			name: 'Nutella',
			checked: false,
			checked_at: null,
			last_bought_at: BOUGHT,
			deleted_at: '2026-09-09T09:00:00.000Z'
		});

		await applyDedupHit(item);

		const row = await db.items.get(item.id);
		expect(row?.deleted_at).toBeNull(); // lifted, back on the list
		expect(row?.checked).toBe(false);
		expect(row?.last_bought_at).toBe(BOUGHT);
		// The create-copy branch, not the history copy: same words as a fresh
		// add, because it is the same intent.
		expect(showToast.mock.calls[0][0]).toBe(t('add_added', { name: 'Nutella' }));

		// …and the undo is the return trip: back to a remembered tombstone
		// with the purchase date intact.
		await lastUndo()();
		const undone = await db.items.get(item.id);
		expect(undone?.deleted_at).not.toBeNull();
		expect(undone?.last_bought_at).toBe(BOUGHT);
	});
});

// [D-200] A re-add is a new entry: it does not bring back the last trip's
// quantity (and, from the add bar or the scanner, not its note either) — and
// the undo puts both back, one op for the whole re-add.
describe('a re-add starts fresh', () => {
	const bought = () =>
		seed({
			name: 'Milch',
			quantity: '2',
			note: 'bio',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});

	it('from the add bar or the scanner: no quantity, no note', async () => {
		const item = await bought();

		await applyDedupHit(item);

		const row = await db.items.get(item.id);
		expect(row?.checked).toBe(false);
		expect(row?.quantity).toBe('');
		expect(row?.note).toBeNull();
		const ops = await opFor(item.id);
		expect(ops).toHaveLength(1);
		expect(ops[0].changed).toMatchObject({ checked: false, quantity: '', note: null });
		expect(ops[0].base).toMatchObject({ quantity: '2', note: 'bio' });
	});

	it('from the history screen: the note comes back, the quantity does not', async () => {
		const item = await bought();

		await reactivate(item);

		const row = await db.items.get(item.id);
		expect(row?.quantity).toBe('');
		expect(row?.note).toBe('bio');
	});

	it('the undo brings the quantity and note back', async () => {
		const item = await bought();
		await applyDedupHit(item);

		await lastUndo()();

		const row = await db.items.get(item.id);
		expect(row?.quantity).toBe('2');
		expect(row?.note).toBe('bio');
	});

	it('an item that is on the list right now is left alone', async () => {
		const item = await seed({ name: 'Brot', quantity: '1', note: 'Vollkorn' });

		await applyDedupHit(item);

		const row = await db.items.get(item.id);
		expect(row?.quantity).toBe('1');
		expect(row?.note).toBe('Vollkorn');
		expect(await opFor(item.id)).toHaveLength(0);
	});
});

// [D-285] An amount typed with the name is set on the row it finds.
describe('applyDedupHit with a typed quantity', () => {
	it('sets it on a row that is on the list, and the undo puts the old one back', async () => {
		const item = await seed({ name: 'Brot', quantity: '1' });

		await applyDedupHit(item, undefined, '2');

		expect((await db.items.get(item.id))?.quantity).toBe('2');
		expect(showToast.mock.calls.at(-1)?.[0]).toBe(
			t('add_dedup_quantity', { name: 'Brot', quantity: '2' })
		);
		await lastUndo()();
		expect((await db.items.get(item.id))?.quantity).toBe('1');
	});

	it('writes nothing when the row already has that quantity', async () => {
		const item = await seed({ name: 'Brot', quantity: '2' });

		await applyDedupHit(item, undefined, '2');

		expect(await opFor(item.id)).toHaveLength(0);
		expect(showToast.mock.calls.at(-1)?.[0]).toBe(t('add_dedup_active', { name: 'Brot' }));
	});

	it('brings a bought row back with it, in one op, and the undo restores the last trip', async () => {
		const item = await seed({
			name: 'Milch',
			quantity: '1 l',
			note: 'bio',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});

		await applyDedupHit(item, undefined, '2 l');

		const row = await db.items.get(item.id);
		expect(row?.checked).toBe(false);
		expect(row?.quantity).toBe('2 l');
		expect(row?.note).toBeNull();
		const ops = await opFor(item.id);
		expect(ops).toHaveLength(1);
		expect(ops[0].changed).toMatchObject({ checked: false, quantity: '2 l', note: null });

		await lastUndo()();
		const undone = await db.items.get(item.id);
		expect(undone?.quantity).toBe('1 l');
		expect(undone?.note).toBe('bio');
	});
});

// [D-254] a text import into an existing list: creates through the outbox,
// brings bought rows back like a re-add, and says nothing per row.
describe('addImported', () => {
	it('creates the new rows in the aisle the plan chose', async () => {
		const count = await addImported(LIST, [
			{ name: 'Mango', quantity: '', note: null, categoryKey: 'cat-produce' },
			{ name: 'Brot', quantity: '', note: null, categoryKey: null }
		]);

		expect(count).toBe(2);
		const rows = await db.items.where('list').equals(LIST).toArray();
		expect(rows.map((r) => [r.name, r.category_key, r.checked]).sort()).toEqual([
			['Brot', null, false],
			['Mango', 'cat-produce', false]
		]);
		expect(await db.pending_ops.count()).toBe(2);
		expect(showToast).not.toHaveBeenCalled();
	});

	it('writes the batch in one commit, so a screen re-reads the list once', async () => {
		const seen: number[] = [];
		const sub = liveQuery(() => db.items.where('list').equals(LIST).count()).subscribe((n) =>
			seen.push(n)
		);
		await vi.waitFor(() => expect(seen).toEqual([0]));

		await addImported(LIST, [
			{ name: 'Mango', quantity: '', note: null, categoryKey: null },
			{ name: 'Brot', quantity: '', note: null, categoryKey: null },
			{ name: 'Eier', quantity: '', note: null, categoryKey: null }
		]);

		await vi.waitFor(() => expect(seen.at(-1)).toBe(3));
		sub.unsubscribe();
		expect(seen).toEqual([0, 3]);
	});

	it('brings a bought row back fresh, in one op, instead of a second row', async () => {
		const item = await seed({
			name: 'Milch',
			quantity: '2',
			note: 'bio',
			deleted_at: BOUGHT,
			last_bought_at: BOUGHT
		});

		expect(
			await addImported(LIST, [
				{ name: 'Milch', quantity: '', note: null, categoryKey: null, existing: item }
			])
		).toBe(1);

		const row = await db.items.get(item.id);
		expect(row).toMatchObject({ deleted_at: null, checked: false, quantity: '', note: null });
		expect(await db.items.count()).toBe(1);
		expect(await opFor(item.id)).toHaveLength(1);
		expect(showToast).not.toHaveBeenCalled();
	});

	it("carries the text's quantity, onto a new row and onto one that comes back", async () => {
		const item = await seed({
			name: 'Milch',
			quantity: '2',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});

		await addImported(LIST, [
			{ name: 'Kartoffeln', quantity: '1 kg', note: null, categoryKey: null },
			{ name: 'Milch', quantity: '1 l', note: null, categoryKey: null, existing: item }
		]);

		const rows = await db.items.where('list').equals(LIST).toArray();
		expect(rows.map((r) => [r.name, r.quantity]).sort()).toEqual([
			['Kartoffeln', '1 kg'],
			['Milch', '1 l']
		]);
		expect(await opFor(item.id)).toHaveLength(1);
	});

	it('skips a row that went back on the list since the screen was opened', async () => {
		const stale = await seed({ name: 'Eier', checked: true, checked_at: BOUGHT });
		await db.items.update(stale.id, { checked: false, checked_at: null });

		expect(
			await addImported(LIST, [
				{ name: 'Eier', quantity: '', note: null, categoryKey: null, existing: stale }
			])
		).toBe(0);
		expect(await opFor(stale.id)).toHaveLength(0);
	});
});

describe('addItemWithUndo', () => {
	it('after a [D-29] merge remap, the undo tombstones the SURVIVOR by name', async () => {
		// The merge settle deletes the client-minted id (push.ts), so the undo
		// closure's reload misses — a silent no-op would break the §9.1 safety
		// net exactly when a merge had landed. The survivor is
		// resolved by normalized name and tombstoned: the visible outcome the
		// tap promised ("the article I just added is gone again").
		const survivor = await seed({
			name: 'Milch',
			checked: true,
			checked_at: BOUGHT,
			last_bought_at: BOUGHT
		});

		const minted = await addItemWithUndo(
			LIST,
			{ name: 'Milch' },
			t('add_added', { name: 'Milch' })
		);

		// Simulate the merged settle: the dead id's row is deleted, exactly
		// what push.ts' merged handler does to the orphaned optimistic row.
		await db.items.delete(minted);

		await lastUndo()();

		const row = await db.items.get(survivor.id);
		expect(row?.deleted_at).not.toBeNull(); // tombstoned, not silently kept
		expect(row?.last_bought_at).toBe(BOUGHT); // stamps untouched by a delete
	});

	it('the normal (un-merged) undo still tombstones the minted row', async () => {
		const minted = await addItemWithUndo(LIST, { name: 'Frischkäse' }, 'x');

		await lastUndo()();

		expect((await db.items.get(minted))?.deleted_at).not.toBeNull();
	});
});
