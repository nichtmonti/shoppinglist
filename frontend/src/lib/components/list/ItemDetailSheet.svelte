<!--
  §9.1's item sheet (rename, quantity, note, aisle, remove), opened from a
  list-view row. No Save: a field commits on change (aisle) or blur (text),
  and every way of closing flushes the rest.

  `item` is the live row, so edits target the current row; drafts are seeded
  once per opened item, so a store refresh never clobbers a keystroke.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { RadioGroup } from 'bits-ui';
	import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
	import { displayName } from '#lib/item-name.js';
	import {
		categoryName,
		categoryStyle,
		sortCategories,
		visibleCategories
	} from '#lib/categories.js';
	import {
		itemDrafts,
		itemEditPatch,
		type ItemDrafts,
		type ItemEditPatch
	} from '#lib/item-edit.js';
	import { t } from '#lib/i18n/index.js';
	import { editItem, removeItem } from '#lib/actions/items.js';
	import { showToast } from '#lib/toasts.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import CategoryIcon from '#lib/components/common/CategoryIcon.svelte';
	import ProductMedia from '#lib/components/common/ProductMedia.svelte';
	import { PickerTile } from '#lib/components/ui/picker-tile/index.js';
	import RemoveItemButton from './RemoveItemButton.svelte';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import { Kept } from '#lib/state/kept.svelte.js';
	import { Field, FieldLabel } from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';

	interface Props {
		/** The open row, or null when the sheet is closed. */
		item: Item | null;
		categories: ListCategory[];
		templates: Map<string, CategoryTemplate>;
		/** The sheet is done with `item` — the caller stops showing it. */
		onclose: () => void;
		/** Where a committed edit goes; defaults to the item mutation. The text
		 *  import's review ([D-254]) keeps it in its own drafts instead. */
		onedit?: (patch: ItemEditPatch) => void;
		/** What the remove button does; defaults to removing the item. */
		onremove?: () => void;
		/** Whether another row on the list already has this name: such a
		 *  rename is not saved, since the server merges names only on an add
		 *  and the list would show the name twice. */
		nameTaken?: (name: string, item: Item) => boolean;
	}

	let { item, categories, templates, onclose, onedit, onremove, nameTaken }: Props = $props();

	// What the sheet shows, kept while it slides closed; edits go to `item`.
	const shown = new Kept(() => item);

	let drafts = $state<ItemDrafts>({ name: '', quantity: '', note: '', category: '' });
	// What the drafts last matched: as opened, then as committed. Only a field
	// the user changed since is sent (itemEditPatch).
	let committed: ItemDrafts = { name: '', quantity: '', note: '', category: '' };
	// Per opening: the rows never render a photo.
	let photoFailed = $state(false);

	// Seed once per opened item, before it renders.
	let seededId: string | null = null;
	let seeded: Item | null = null;
	$effect.pre(() => {
		const open = item;
		if (open?.id === seededId) {
			seeded = open;
			return;
		}
		// The row left without a close (a co-shopper ticked it off, so the list
		// no longer shows it): what was typed still commits.
		const left = seeded;
		if (left) untrack(() => void commit(left));
		seededId = open?.id ?? null;
		seeded = open;
		if (open) {
			untrack(() => {
				drafts = itemDrafts(open, categories);
				committed = { ...drafts };
				photoFailed = false;
			});
		}
	});

	// The aisle picker: the list's visible categories, aisle order.
	let pickerCategories = $derived(sortCategories(visibleCategories(categories), templates));

	/** Commits only what changed, as one outbox op. */
	async function commit(target: Item): Promise<void> {
		const patch = itemEditPatch(target, drafts, categories, committed);
		if (patch.name !== undefined && nameTaken?.(patch.name, target)) {
			showToast(t('add_dedup_active', { name: patch.name }));
			delete patch.name;
			if (seededId === target.id) drafts.name = displayName(target);
		}
		committed = $state.snapshot(drafts);
		if (Object.keys(patch).length === 0) return;
		if (onedit) onedit(patch);
		else await editItem(target, patch);
	}

	function commitOnBlur(): void {
		if (item) void commit(item);
	}

	// Going to another app may be the last this page sees: iOS can unload it in
	// the background, and the drafts would go with it ([D-293]).
	function commitWhenHidden(): void {
		if (document.visibilityState === 'hidden') commitOnBlur();
	}

	// The edit or removal is handed over before `onclose`, while the caller
	// still holds the row it opened (the import review's key).
	function close(): void {
		const target = item;
		if (target) void commit(target);
		onclose();
	}

	function remove(): void {
		const target = item;
		if (!target) return;
		// Not close(): committing drafts would race the delete.
		committed = $state.snapshot(drafts);
		if (onremove) onremove();
		else void removeItem(target);
		onclose();
	}
</script>

<svelte:document onvisibilitychange={commitWhenHidden} />
<svelte:window onpagehide={commitOnBlur} />

{#snippet headerActions()}
	{#if shown.value}
		<RemoveItemButton name={displayName(shown.value)} onremove={remove} />
	{/if}
{/snippet}

<Sheet open={item !== null} title={t('list_detail_title')} onclose={close} {headerActions}>
	{#if shown.value}
		{@const row = shown.value}
		<div class="flex flex-col">
			<ProductMedia
				url={row.image_url}
				name={displayName(row)}
				barcode={row.barcode}
				failed={photoFailed}
				onerror={() => (photoFailed = true)}
				class="mb-3.5"
			/>
			<!-- Compact so the whole sheet fits a phone screen: labels are sr-only
			     beside placeholders, and the aisles are an icon grid named by the
			     radios' accessible names. -->
			<div class="mb-2 flex w-full gap-2">
				<Field class="min-w-0 flex-1">
					<FieldLabel for="detail-name" class="sr-only">{t('common_name')}</FieldLabel>
					<Input
						id="detail-name"
						dir="auto"
						maxlength={maxBytesFor('items', 'name')}
						placeholder={t('common_name')}
						bind:value={drafts.name}
						onblur={commitOnBlur}
					/>
				</Field>
				<Field class="w-28 flex-none">
					<FieldLabel for="detail-quantity" class="sr-only">{t('common_quantity')}</FieldLabel>
					<Input
						id="detail-quantity"
						dir="auto"
						maxlength={maxBytesFor('items', 'quantity')}
						placeholder={t('common_quantity')}
						bind:value={drafts.quantity}
						onblur={commitOnBlur}
					/>
				</Field>
			</div>
			<Field class="mb-3 w-full">
				<FieldLabel for="detail-note" class="sr-only">{t('common_note')}</FieldLabel>
				<Input
					id="detail-note"
					dir="auto"
					maxlength={maxBytesFor('items', 'note')}
					placeholder={t('list_note_placeholder')}
					bind:value={drafts.note}
					onblur={commitOnBlur}
				/>
			</Field>
			<!-- 24% of the aisle colour, not a chip's 14%: here the colour is half
			     of what a tile says ([D-251]). -->
			<RadioGroup.Root
				value={drafts.category}
				onValueChange={(v) => {
					drafts.category = v;
					if (item) void commit(item);
				}}
				aria-label={t('common_category')}
				class="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5"
			>
				{#each pickerCategories as cat (cat.id)}
					{@const name = categoryName(cat, templates)}
					<PickerTile
						value={cat.id}
						aria-label={name}
						title={name}
						class="cat-plate-24 grid h-11 place-items-center rounded-control border cat-border-28 hover:cat-border-55"
						style={categoryStyle(cat.color)}
					>
						<CategoryIcon icon={cat.icon} chip={2.75} />
					</PickerTile>
				{/each}
			</RadioGroup.Root>
		</div>
	{/if}
</Sheet>
