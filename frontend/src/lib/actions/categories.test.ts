// #lib/actions/categories.ts — hide is the mutation this suite exists for: a
// destructive action, so it carries a one-tap undo (§9.1: "no destructive
// action is left without a one-tap safety net"). The outbox is left REAL, same as items.test.ts — the
// claim under test includes the op shape (a tombstone ride, not a field
// patch), and a double would prove nothing about that. Only `showToast` is
// stubbed so the undo callback can be captured and invoked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/toasts.js', async () =>
	(await import('#lib/test-kit/toasts-mock.js')).toastsModuleMock({ showToast })
);

import { db } from '#lib/db.js';
import { t } from '#lib/i18n/index.js';
import { makeCategory, putSynced, resetDb } from '#lib/test-kit/db.js';
import { hideCategory } from './categories';

const LIST = 'list-1';

function seed(overrides: { name: string; slug?: string | null }) {
	return makeCategory({ list: LIST, slug: overrides.slug ?? null, name: overrides.name });
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

describe('hideCategory', () => {
	it('tombstones the row, raises the safety net, and the undo clears the tombstone', async () => {
		const cat = seed({ name: 'Obst & Gemüse' });
		await putSynced([], [cat]);

		await hideCategory(cat, 'Obst & Gemüse');

		const hidden = await db.list_categories.get(cat.id);
		expect(hidden?.deleted_at).not.toBeNull();
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(showToast.mock.calls[0][0]).toBe(
			t('categories_hidden_toast', { name: 'Obst & Gemüse' })
		);

		await lastUndo()();

		const restored = await db.list_categories.get(cat.id);
		expect(restored?.deleted_at).toBeNull();
	});

	it('queues the hide as a tombstone ride (deleted: true), not a field patch', async () => {
		const cat = seed({ name: 'Molkerei' });
		await putSynced([], [cat]);

		await hideCategory(cat, 'Obst & Gemüse');

		const ops = await db.pending_ops.where('record_id').equals(cat.id).toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0].type).toBe('update');
		expect(ops[0].changed).toEqual({ deleted: true });
	});

	it('still refuses the Others row before anything is written', async () => {
		const others = seed({ name: 'Sonstiges', slug: 'other' });
		await putSynced([], [others]);

		await expect(hideCategory(others, 'Sonstiges')).rejects.toThrow(/cannot be hidden/);

		const row = await db.list_categories.get(others.id);
		expect(row?.deleted_at).toBeNull();
		expect(showToast).not.toHaveBeenCalled();
	});
});
