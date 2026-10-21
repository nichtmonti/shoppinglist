<!--
  §9.1 one list-view (planning) row: aisle chip, name + note, and the quantity
  control. Removal lives in the detail sheet, reached through the name or the
  chip ([D-119]), and, given `onremove`, in a swipe to the left ([D-289]).
  Pure presentation like ShopTile: every side effect is a callback, so
  ListView and /dev/gallery share it.

  `cat` is also the mode switch: A→Z rows pass their aisle and get the chip,
  grouped rows pass null because the aisle header already names it.
-->
<script lang="ts">
	import CategoryIcon from '#lib/components/common/CategoryIcon.svelte';
	import { displayName, isScanned } from '#lib/item-name.js';
	import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
	import { categoryName, categoryStyle } from '#lib/categories.js';
	import { t } from '#lib/i18n/index.js';
	import Camera from '@lucide/svelte/icons/camera';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { dur } from '#lib/state/motion.js';
	import { SETTLE_MS, SWIPE_AT_REST, swipeToRemove } from './swipe-remove.js';
	import QuantityControl from '#lib/components/common/QuantityControl.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		item: Item;
		/** The row's aisle — null/undefined under an aisle header, which suppresses the chip. */
		cat?: ListCategory | null;
		templates: Map<string, CategoryTemplate>;
		/** The last row of its group, which paints no separator: the aisle
		 *  header under it is ruled ([D-332]), and so is the section below. */
		last?: boolean;
		/** Open the detail sheet (rename / note / aisle / remove). */
		onopen?: () => void;
		/** Overrides where a committed quantity goes; defaults to the item mutation. */
		onquantity?: (value: string) => void | Promise<void>;
		/** Remove the item; given, a swipe to the left does it ([D-289]). */
		onremove?: () => void;
		/** Rendered before everything else: the text import's checkbox ([D-254]). */
		lead?: Snippet;
		/** A line under the name that is not the item's own (the import's "schon auf der Liste"). */
		hint?: string | null;
		/** The name text's id (and `<id>-hint` the hint's), for a `lead` control to be labelled by. */
		nameId?: string;
	}

	let {
		item,
		cat = null,
		templates,
		last = false,
		onopen,
		onquantity,
		onremove,
		lead,
		hint = null,
		nameId
	}: Props = $props();

	// Scan provenance, the same predicate as a shop tile's `product` kind. It is
	// a badge on the chip, not its own element, so it costs the name no width;
	// grouped mode has no chip and so no badge.
	let scanned = $derived(isScanned(item));

	// Read through a getter, so a row re-rendered by a sync mid-swipe keeps
	// its gesture.
	let swipe = $state(SWIPE_AT_REST);
	const swipeable = swipeToRemove({ remove: () => onremove, update: (s) => (swipe = s) });

	// An inset rule means "another row", leaving the full-bleed rule to mean "a
	// new section" (§9.1). A group's last row paints none: the next aisle
	// header's rule, or PrevItemsLink's section rule, sits beneath it [D-128].
	let ruleClass = $derived(
		last
			? ''
			: `after:absolute after:bottom-0 after:end-0 after:h-px after:bg-border after:content-[''] ${
					cat ? 'after:start-(--row-rule-inset)' : 'after:start-(--row-gutter)'
				}`
	);
</script>

{#if onremove}
	<!-- Clipped only while moved: at rest a clip would cut focus rings. -->
	<div class="swipe-row relative" class:overflow-hidden={swipe.offset !== 0}>
		{#if swipe.offset !== 0}
			<div
				class="swipe-under absolute inset-0 flex items-center justify-end pe-(--row-gutter) bg-danger text-danger-foreground"
				data-testid="swipe-under"
				aria-hidden="true"
			>
				<Trash2
					class="size-5 shrink-0 transition-transform duration-100 {swipe.armed
						? 'scale-125'
						: 'scale-100'}"
				/>
			</div>
		{/if}
		{@render body()}
	</div>
{:else}
	{@render body()}
{/if}

{#snippet body()}
	<div
		class="list-row relative flex items-center gap-3 px-(--row-gutter) py-2.5 min-h-13 press-row translate-x-(--swipe-x) {ruleClass} {onremove
			? 'touch-pan-y touch-pinch-zoom'
			: ''} {onremove && !swipe.dragging
			? 'transition-transform duration-(--settle) ease-out'
			: ''}"
		class:bg-background={swipe.offset !== 0}
		class:select-none={swipe.dragging}
		style:--swipe-x={swipe.offset ? `${swipe.offset}px` : undefined}
		style:--settle="{dur(SETTLE_MS)}ms"
		data-testid="row"
		data-id={item.id}
		class:has-category={!!cat}
		{@attach swipeable}
	>
		{@render lead?.()}
		{#if cat}
			<!-- The chip opens the detail sheet too, where the aisle is changed. The
			     inner span clips the artwork: `overflow-hidden` on the button would
			     clip its hit-target ::after to 38px ([D-56], [D-228]). -->
			<button
				type="button"
				class="cat-chip relative size-9.5 flex-none rounded-chip cat-plate-14 border cat-border-28 cursor-pointer hover:cat-border-55 hit-target"
				data-testid="cat-chip"
				style={categoryStyle(cat.color)}
				onclick={() => onopen?.()}
				aria-label={t('list_row_category', {
					category: categoryName(cat, templates),
					name: displayName(item)
				})}
				><span class="relative grid size-full place-items-center overflow-hidden rounded-chip"
					><CategoryIcon icon={cat.icon} chip={2.375} />{#if scanned}<span
							class="cat-chip-scan corner-mark absolute top-0 inset-e-0 size-3.5 bg-primary text-primary-foreground"
							aria-hidden="true"
						>
							<Camera class="size-2" /></span
						>{/if}</span
				></button
			>
		{/if}
		<button
			type="button"
			class="row-name flex-1 min-w-0 flex flex-col justify-center gap-px self-stretch -my-2.5 focus-visible:-outline-offset-2 text-start cursor-pointer"
			onclick={() => onopen?.()}
		>
			<span id={nameId} class="row-name-main text-base/tight font-book truncate" dir="auto"
				>{displayName(item)}</span
			>
			{#if item.note}
				<span class="text-note/flush font-book text-muted-foreground truncate" dir="auto"
					>{item.note}</span
				>
			{/if}
			{#if hint}
				<span
					id={nameId ? `${nameId}-hint` : undefined}
					class="text-micro/flush text-muted-foreground italic truncate">{hint}</span
				>
			{/if}
		</button>
		<QuantityControl {item} oncommit={onquantity} />
	</div>
{/snippet}
