<!--
  The list view's item area (§9.1): loading and empty states, then the
  unchecked items, A–Z with an aisle chip or under aisle headers. Shared by
  ListView and /dev/gallery ([D-228]). Each slot's `data-item` is how the add
  box's dedup jump and the gallery harnesses find a row.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
	import { groupByAisle, sortByName } from '#lib/sorting.js';
	import { categoryName, categoryOf } from '#lib/categories.js';
	import { dur, flipNear, ROW_FLIP_MS } from '#lib/state/motion.js';
	import AisleHeader from '#lib/components/common/AisleHeader.svelte';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import ViewEmptyState from '#lib/components/common/ViewEmptyState.svelte';
	import ListRow from './ListRow.svelte';

	interface Props {
		/** False until the store has answered: a skeleton, not "empty". */
		loaded: boolean;
		/** Any living item at all — "no items" and "all done" are different
		 *  empty states (§9.1). */
		hasAny: boolean;
		active: Item[];
		sort: 'az' | 'category';
		categories: ListCategory[];
		templates: Map<string, CategoryTemplate>;
		onopen: (item: Item) => void;
		/** Replaces the row's own quantity write; the gallery keeps it local. */
		onquantity?: (item: Item, value: string) => void;
		/** Given, a row swiped toward its start removes its item ([D-289]). */
		onremove?: (item: Item) => void;
		/** Rendered under a row, inside its slot. */
		below?: Snippet<[Item]>;
	}

	let {
		loaded,
		hasAny,
		active,
		sort,
		categories,
		templates,
		onopen,
		onquantity,
		onremove,
		below
	}: Props = $props();

	// Only the visible ordering is computed.
	let activeAZ = $derived(sort === 'az' ? sortByName(active) : active);
	let groups = $derived(sort === 'category' ? groupByAisle(active, categories, templates) : []);
</script>

{#snippet row(item: Item, cat: ListCategory | null, last: boolean)}
	<ListRow
		{item}
		{cat}
		{templates}
		{last}
		onopen={() => onopen(item)}
		onquantity={onquantity && ((value) => onquantity(item, value))}
		onremove={onremove && (() => onremove(item))}
	/>
	{@render below?.(item)}
{/snippet}

<!-- Unreached when the route preloaded ([D-205]); the fallback for a
     read that outlasted the preload's cap. -->
{#if !loaded}
	<EmptyState aria-busy="true" />
{:else if !hasAny}
	<ViewEmptyState view="list" state="empty" />
{:else if active.length === 0}
	<ViewEmptyState view="list" state="done" />
{:else if sort === 'az'}
	{#each activeAZ as item, i (item.id)}
		<div
			class="row-slot block"
			data-item={item.id}
			animate:flipNear={{ duration: dur(ROW_FLIP_MS), easing: cubicOut }}
		>
			{@render row(item, categoryOf(item, categories) ?? null, i === activeAZ.length - 1)}
		</div>
	{/each}
{:else}
	{#each groups as group (group.category.id)}
		<AisleHeader
			title={categoryName(group.category, templates)}
			icon={group.category.icon}
			color={group.category.color}
			count={group.items.length}
		/>
		{#each group.items as item, ii (item.id)}
			<div
				class="row-slot block"
				data-item={item.id}
				animate:flipNear={{ duration: dur(ROW_FLIP_MS), easing: cubicOut }}
			>
				{@render row(item, null, ii === group.items.length - 1)}
			</div>
		{/each}
	{/each}
{/if}
