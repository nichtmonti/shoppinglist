<!--
  The shop view's item area (§9.1): loading and empty states, then the
  unchecked items as tiles, in aisles or one A–Z grid; or, with `rows`, as
  one run of rows in aisle order (or A–Z), each led by its category
  ([D-313]). Shared by ShopView and /dev/gallery ([D-228]). The gallery harnesses find a cell by `data-item`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SvelteSet } from 'svelte/reactivity';
	import { cubicOut } from 'svelte/easing';
	import { on } from 'svelte/events';
	import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
	import { groupByAisle, sortByName } from '#lib/sorting.js';
	import { categoryName, categoryOf } from '#lib/categories.js';
	import type { TileMark } from './tile-model';
	import { dur, flipNear, ROW_FLIP_MS } from '#lib/state/motion.js';
	import AisleHeader from '#lib/components/common/AisleHeader.svelte';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import ViewEmptyState from '#lib/components/common/ViewEmptyState.svelte';
	import ShopTile from './ShopTile.svelte';
	import { noteMoved } from './tap-guard';

	interface Props {
		/** False until the store has answered: a skeleton, not "empty". */
		loaded: boolean;
		/** Any living item at all — "no items" and "all done" are different
		 *  empty states (§9.1). */
		hasAny: boolean;
		unchecked: Item[];
		sort: 'az' | 'category';
		categories: ListCategory[];
		templates: Map<string, CategoryTemplate>;
		/** The list density ([D-313]): one run of rows with no aisle headers,
		 *  each led by its category's icon. */
		rows: boolean;
		/** Ids whose photo failed to load; shared with the caller's sheet. */
		failedPhotos: SvelteSet<string>;
		oncheck: (item: Item, event: MouseEvent) => void;
		oninfo: (item: Item) => void;
		/** Rendered under a tile, inside its grid cell. */
		below?: Snippet<[Item]>;
	}

	let {
		loaded,
		hasAny,
		unchecked,
		sort,
		categories,
		templates,
		rows,
		failedPhotos,
		oncheck,
		oninfo,
		below
	}: Props = $props();

	// The tiles re-measure whether their text is cut ([D-83]) when the line
	// they measure against can have changed: the probe has the tile's inline padding, in
	// rem, so its width follows the shop's width, the text size and the
	// density; and when a font finishes loading. The probe sits above the
	// aisles in the tree (.shop-items is display: contents), so a re-measure
	// inside its notification resizes only deeper boxes, tiles and aisles,
	// which the browser delivers in the same frame. A size at the probe's depth
	// or above changing there would be a ResizeObserver loop error.
	// The content box, not the border box: a text-size change moves the padding
	// inside a width that stays.
	let probeBox = $state<DOMRectReadOnly>();
	let fontsLoaded = $state(0);
	$effect(() =>
		document.fonts ? on(document.fonts, 'loadingdone', () => fontsLoaded++) : undefined
	);
	// A new token whenever either changes; the tiles only watch it.
	let remeasure = $derived([probeBox, fontsLoaded]);

	// A tile's slide is also what the tap guard keys on ([D-213]): Svelte runs
	// it only for a tile whose place changed.
	function slide(
		node: Element,
		positions: { from: DOMRect; to: DOMRect },
		params: Parameters<typeof flipNear>[2]
	) {
		noteMoved(node);
		return flipNear(node, positions, params);
	}

	let alphabetical = $derived(sort === 'az' && !rows ? sortByName(unchecked) : []);
	let aisles = $derived(
		sort === 'category' && !rows ? groupByAisle(unchecked, categories, templates) : []
	);

	// The marked run: one grid, the aisle order kept without its headers.
	let marked = $derived.by(() => {
		if (!rows) return [];
		const order =
			sort === 'az'
				? sortByName(unchecked)
				: groupByAisle(unchecked, categories, templates).flatMap((aisle) => aisle.items);
		return order.map((item) => {
			const category = categoryOf(item, categories);
			return { item, category: category?.id ?? '', mark: markOf(category) };
		});
	});
	let markFor = $derived(new Map(marked.map((row, i) => [row.item.id, { ...row, i }])));

	function markOf(category: ListCategory | undefined): TileMark | null {
		if (!category) return null;
		return {
			icon: category.icon,
			color: category.color,
			name: categoryName(category, templates)
		};
	}
</script>

{#snippet tiles(items: Item[])}
	<!-- Intrinsic columns in rem ([D-83], shop-layout.css). -->
	<div class="shop-grid grid" class:marked={rows}>
		{#each items as item (item.id)}
			{@const row = markFor.get(item.id)}
			<div
				class="tile-wrap min-w-0"
				data-item={item.id}
				data-cat={row?.category}
				data-run-start={row && marked[row.i - 1]?.category !== row.category ? '' : undefined}
				data-run-end={row && marked[row.i + 1]?.category !== row.category ? '' : undefined}
				animate:slide={{ duration: dur(ROW_FLIP_MS), easing: cubicOut }}
			>
				<ShopTile
					{item}
					row={rows}
					mark={row?.mark}
					photoFailed={failedPhotos.has(item.id)}
					onphotoerror={() => failedPhotos.add(item.id)}
					oncheck={(event) => oncheck(item, event)}
					oninfo={() => oninfo(item)}
					{remeasure}
				/>
				{@render below?.(item)}
			</div>
		{/each}
	</div>
{/snippet}

<div class="shop-probe" aria-hidden="true" bind:contentRect={probeBox}></div>
<div class="shop-items">
	<!-- Unreached when the route preloaded ([D-205]); the fallback for a
	     read that outlasted the preload's cap. -->
	{#if !loaded}
		<EmptyState aria-busy="true" />
	{:else if !hasAny}
		<ViewEmptyState view="shop" state="empty" />
	{:else if unchecked.length === 0}
		<ViewEmptyState view="shop" state="done" />
	{:else if rows}
		{@render tiles(marked.map((row) => row.item))}
	{:else if sort === 'az'}
		{@render tiles(alphabetical)}
	{:else}
		{#each aisles as aisle (aisle.category.id)}
			<section class="aisle">
				<AisleHeader
					title={categoryName(aisle.category, templates)}
					icon={aisle.category.icon}
					color={aisle.category.color}
					count={aisle.items.length}
				/>
				{@render tiles(aisle.items)}
			</section>
		{/each}
	{/if}
</div>
