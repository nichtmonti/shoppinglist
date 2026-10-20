// Every mutation of shared item data goes through this module: §8.2 [D-40]
// requires row + op to be written atomically, which only `createRecord` /
// `updateRecord` / `deleteRecord` / `restoreRecord` do. A bare `db.items.put()`
// writes a row the outbox never pushes, and the next repair snapshot (§8.5)
// reverts it. The §9.1 undo toasts live here too, so the views cannot drift on
// the copy or on which actions get a safety net.
import { v4 } from 'uuid';
import { db, type Item } from '#lib/db.js';
import {
	createRecord,
	deleteRecord,
	inOneCommit,
	queryLatestCheckOffs,
	restoreRecord,
	updateRecord
} from '#lib/sync/index.js';
import { showToast } from '#lib/toasts.js';
import { t } from '#lib/i18n/index.js';
import { recentlyChecked, TRIP_GAP_MS } from '#lib/sorting.js';
import { findByName } from '#lib/dedup.js';
import { displayName, hasLocalizedNames } from '#lib/item-name.js';
import { LIST_MAX_ITEMS } from '#lib/config.js';

export interface NewItemFields {
	name: string;
	/** A scanned product's localized names ([D-21]); typed items have none. */
	name_de?: string | null;
	name_en?: string | null;
	category_key?: string | null;
	quantity?: string;
	note?: string | null;
	barcode?: string | null;
	/** The photo the barcode's lookup returned: shown until the server's settle,
	 *  never sent, since the server stamps it from the barcode ([D-266]). */
	image_url?: string | null;
}

/**
 * Create an item with a client-minted id (§8.2). The server may answer
 * `merged` for a duplicate name ([D-29]) and the outbox then remaps this id to
 * the surviving row, so never cache the returned id across a sync cycle.
 */
export async function addItem(listId: string, fields: NewItemFields): Promise<string> {
	const id = v4();
	await createRecord(
		'items',
		listId,
		id,
		{
			name: fields.name,
			name_de: fields.name_de ?? null,
			name_en: fields.name_en ?? null,
			quantity: fields.quantity ?? '',
			note: fields.note ?? null,
			category_key: fields.category_key ?? null,
			barcode: fields.barcode ?? null,
			checked: false
		},
		{ stamps: { image_url: fields.image_url ?? null } }
	);
	return id;
}

/**
 * Check or uncheck. `checked_at` / `last_bought_at` are server-stamped and
 * never ride in an op ([D-26]); the optimistic local stamps keep a just-checked
 * row in the recently-checked section while offline (§6.6). An uncheck keeps
 * `last_bought_at`, so a re-activated row keeps its purchase date (§6.10,
 * [D-18]); one that takes the tick back (`notBought`: the undo, putting it
 * back from the done pile) tells the server, which restores the date the tick
 * replaced. `boughtBefore` shows that date at once, when the caller knows it.
 */
export async function setChecked(
	item: Item,
	checked: boolean,
	untick: { notBought?: boolean; boughtBefore?: string | null } = {}
): Promise<void> {
	const now = new Date().toISOString();
	if (checked) {
		await updateRecord(
			'items',
			item,
			{ checked },
			{ stamps: { checked_at: now, last_bought_at: now } }
		);
		return;
	}
	const known = untick.boughtBefore !== undefined;
	await updateRecord('items', item, untick.notBought ? { checked, bought: false } : { checked }, {
		stamps: {
			checked_at: null,
			...(untick.notBought && known ? { last_bought_at: untick.boughtBefore } : {})
		}
	});
}

/** Check an item off, or back on, with the §9.1 undo toast. Taking a tick
 *  back (its undo, or putting the item back from the done pile) says the item
 *  was not bought, so it keeps the purchase date it had before. */
export async function toggleChecked(item: Item): Promise<void> {
	const next = !item.checked;
	await setChecked(item, next, { notBought: true });
	const name = displayName(item);
	showToast(
		next ? t('history_toast_checked', { name }) : t('history_toast_restored', { name }),
		async () => {
			// Re-read: the row may have been settled with the server's record since.
			const current = await db.items.get(item.id);
			if (!current) return;
			// The undo of a tick puts back the date it had before the tick.
			await setChecked(current, !next, { notBought: true, boughtBefore: item.last_bought_at });
		}
	);
}

type ResetField = 'quantity' | 'note';

/**
 * Re-add from previous items, restore from recently-checked, or a dedup hit on
 * a checked row: §6.10 makes all three one operation, clear `checked` and keep
 * `last_bought_at`.
 *
 * A removed row comes back in two moves, lifting the tombstone and then
 * clearing `checked`, which the outbox coalesces into one op. The row must be
 * re-read between the two: `enqueue` writes `{...currentRow, ...changed}`, so
 * the stale pre-restore copy would put the tombstone straight back on.
 *
 * `reset` names what of the last trip the row does not bring back ([D-200]);
 * a `quantity` typed with the add is set after it ([D-285]). The undo puts
 * both back.
 */
async function restoreToList(
	item: Item,
	message: string,
	reset: ResetField[],
	quantity = ''
): Promise<void> {
	const { fromThisTrip, cleared } = await bringBack(item, reset);
	if (quantity) {
		const row = await db.items.get(item.id);
		if (row) await setQuantity(row, quantity);
	}
	const wasRemoved = item.deleted_at !== null;
	const wasChecked = item.checked;
	showToast(message, async () => {
		let current = await db.items.get(item.id);
		if (!current) return;
		if (Object.keys(cleared).length > 0 || quantity) {
			const back: Partial<Pick<Item, ResetField>> = {};
			if ('quantity' in cleared || quantity) back.quantity = item.quantity;
			if ('note' in cleared) back.note = item.note;
			await editItem(current, back);
			current = (await db.items.get(item.id)) ?? current;
		}
		// Re-check only a check-off from this trip, or a visible row with no
		// purchase memory (a tombstone would drop it from "Frühere Artikel",
		// [D-79]). Re-checking any other row would stamp a purchase that never
		// happened ([D-26]); its inverse is the tombstone, which keeps both
		// stamps and returns it to previous items where it was.
		if (fromThisTrip || (!wasRemoved && !item.last_bought_at)) {
			if (wasChecked) await setChecked(current, true);
		} else {
			await deleteRecord('items', current);
		}
	});
}

/** restoreToList's write, without the toast: what the undo needs to know comes back. */
async function bringBack(
	item: Item,
	reset: ResetField[]
): Promise<{ fromThisTrip: boolean; cleared: Partial<Pick<Item, ResetField>> }> {
	// Captured now, not when the toast is tapped: the toast can outlive the
	// trip, and the undo owes the row back to the bucket it came from. A trip
	// is the list's run of check-offs ([D-18]), read from the latest ones.
	const checkOffs = await queryLatestCheckOffs(item.list, TRIP_GAP_MS);
	const fromThisTrip = recentlyChecked(checkOffs).some((row) => row.id === item.id);
	let row = item;
	if (item.deleted_at !== null) {
		await restoreRecord('items', item);
		row = (await db.items.get(item.id)) ?? item;
	}
	await setChecked(row, false);
	const cleared: Partial<Pick<Item, ResetField>> = {};
	if (reset.includes('quantity') && item.quantity !== '') cleared.quantity = '';
	if (reset.includes('note') && item.note) cleared.note = null;
	if (Object.keys(cleared).length > 0) {
		row = (await db.items.get(item.id)) ?? row;
		await editItem(row, cleared);
	}
	return { fromThisTrip, cleared };
}

/**
 * The selected rows of a text import into an existing list ([D-254]), through
 * the outbox like any add, so it works offline. A new name is created in the
 * aisle the plan chose; a checked or remembered one comes back the way a
 * re-add from the add bar does (quantity and note reset, [D-200]), then takes
 * what the review gave it: the text's quantity, a note, an aisle the user
 * chose. One toast for the batch, with no undo: nothing was removed, and
 * every row it added can be taken off like any other. Returns how many rows
 * changed.
 */
export async function addImported(
	listId: string,
	rows: {
		name: string;
		quantity: string;
		note: string | null;
		categoryKey: string | null;
		existing?: Item;
	}[]
): Promise<number> {
	// One commit for the batch: the screens re-read the list once, not per row.
	return inOneCommit('items', async () => {
		let count = 0;
		for (const row of rows) {
			if (row.existing) {
				// Re-read: the plan was made from the mirror when the screen opened.
				const current = await db.items.get(row.existing.id);
				if (!current) continue;
				if (current.deleted_at === null && !current.checked) continue;
				await bringBack(current, ['quantity', 'note']);
				// editItem writes only what differs, into the same coalesced op.
				const back = await db.items.get(current.id);
				if (back) {
					await editItem(back, {
						quantity: row.quantity,
						note: row.note,
						category_key: row.categoryKey
					});
				}
			} else {
				await addItem(listId, {
					name: row.name,
					quantity: row.quantity,
					note: row.note,
					category_key: row.categoryKey
				});
			}
			count++;
		}
		return count;
	});
}

/** How many more rows `listId` may take before the push route refuses a
 *  create ([D-217]): the mirror's rows, tombstones included, count. */
export async function roomOnList(listId: string): Promise<number> {
	return Math.max(0, LIST_MAX_ITEMS - (await db.items.where('list').equals(listId).count()));
}

export async function reactivate(item: Item): Promise<void> {
	await restoreToList(item, t('history_toast_restored', { name: displayName(item) }), ['quantity']);
}

/**
 * Act on a row `#lib/dedup.js` found already on the list (§9.1 by name, §9.2
 * by barcode): an active match is revealed, a checked or removed one is
 * re-activated. Shared by the typeahead and the scanner so they cannot
 * disagree. `jump` is the rendering view's own reveal.
 *
 * A `quantity` typed with the name is set on the row either way ([D-285]);
 * without one, an active row keeps the quantity it has.
 */
export async function applyDedupHit(
	existing: Item,
	jump?: (itemId: string) => void,
	quantity = ''
): Promise<void> {
	if (existing.checked || existing.deleted_at !== null) {
		// The same words as a fresh create, with an undo since it mutated a row.
		// An unchecked tombstone belongs here too: it renders nowhere, so a jump
		// would do nothing.
		await restoreToList(
			existing,
			t('add_added', { name: displayName(existing) }),
			['quantity', 'note'],
			quantity
		);
	} else if (quantity && quantity !== existing.quantity) {
		jump?.(existing.id);
		const previous = existing.quantity;
		await setQuantity(existing, quantity);
		showToast(t('add_dedup_quantity', { name: displayName(existing), quantity }), async () => {
			const current = await db.items.get(existing.id);
			if (current) await setQuantity(current, previous);
		});
	} else {
		jump?.(existing.id);
		// The reveal alone is not feedback (scrollIntoView is a no-op for a row
		// on screen, and the focus ring barely shows on touch), so toast it.
		showToast(t('add_dedup_active', { name: displayName(existing) }));
	}
}

/**
 * A scan that lands on an item typed without a barcode gives it the barcode
 * ([D-29], [D-266]): the lookup's photo shows at once, as the barcode's stamp,
 * until the server stamps its own. An item with a barcode keeps it.
 */
export async function attachBarcode(
	item: Item,
	barcode: string,
	imageUrl: string | null
): Promise<void> {
	if (item.barcode) return;
	await updateRecord('items', item, { barcode }, { stamps: { image_url: imageUrl } });
}

/** The §9.1 inline quantity editor. `quantity` stays a free-text string [D-20]. */
export async function setQuantity(item: Item, quantity: string): Promise<void> {
	if (quantity === item.quantity) return;
	await updateRecord('items', item, { quantity });
}

/**
 * Edits from the row detail sheet (§9.1). A rename clears a scanned item's
 * localized names in the same op ([D-21]), even when the new name equals
 * `name`: the renamer saw a localized name and typed over it.
 */
export async function editItem(
	item: Item,
	fields: Partial<Pick<Item, 'name' | 'quantity' | 'note' | 'category_key'>>
): Promise<void> {
	const changed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== item[key as keyof Item]) changed[key] = value;
	}
	if (fields.name !== undefined && hasLocalizedNames(item)) {
		changed.name_de = null;
		changed.name_en = null;
	}
	if (Object.keys(changed).length === 0) return;
	await updateRecord('items', item, changed);
}

/**
 * A create with an undo that tombstones the row. The add box says the same
 * words whether it inserted a row or re-activated one, and the re-activation
 * carries an undo, so this does too (§9.1).
 */
export async function addItemWithUndo(
	listId: string,
	fields: NewItemFields,
	message: string
): Promise<string> {
	const id = await addItem(listId, fields);
	showToast(message, async () => {
		let current = await db.items.get(id);
		if (!current) {
			// A [D-29] merge settled meanwhile and deleted the minted id. The undo
			// still owes the article off the list, so tombstone the survivor by
			// name. In the rare stale-mirror case that is a co-member's row, a
			// deliberate trade-off: the tombstone keeps every field, and a silent
			// no-op broke the §9.1 safety net.
			const survivor = findByName(
				await db.items.where('list').equals(listId).toArray(),
				fields.name
			);
			if (survivor && survivor.deleted_at === null) current = survivor;
		}
		if (current) await deleteRecord('items', current);
	});
	return id;
}

/**
 * Remove = tombstone (§8.2), undone by a restore (§9.1). A row bought before
 * stays in "Frühere Artikel" (§6.10 `countsAsHistory`) and one never bought is
 * gone, so the toast says which.
 */
export async function removeItem(item: Item): Promise<void> {
	const remembered = item.last_bought_at !== null;
	await deleteRecord('items', item);
	showToast(
		remembered
			? t('history_toast_removed_kept', { name: displayName(item) })
			: t('history_toast_removed', { name: displayName(item) }),
		async () => {
			const current = await db.items.get(item.id);
			if (current) await restoreRecord('items', current);
		}
	);
}
