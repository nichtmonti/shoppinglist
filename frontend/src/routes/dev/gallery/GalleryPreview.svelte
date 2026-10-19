<!-- Fixture wiring only: the item area comes from the app's own ShopItems and
     ListItems, the done pile from DoneItems ([D-228]). Changes stay in this
     preview's local copy of the fixtures. -->
<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Item } from '#lib/db.js';
	import { activeItems, livingItems, recentlyChecked } from '#lib/sorting.js';
	import ShopItems from '#lib/components/shop/ShopItems.svelte';
	import DoneItems from '#lib/components/shop/DoneItems.svelte';
	import ListItems from '#lib/components/list/ListItems.svelte';
	import { CATS, TEMPLATES, type Fixture } from './fixtures';

	let {
		initial,
		view,
		density,
		sort,
		loading,
		captions,
		inspect
	}: {
		initial: Fixture[];
		view: 'shop' | 'list';
		density: 'comfortable' | 'compact' | 'list';
		sort: 'az' | 'category';
		loading: boolean;
		captions: boolean;
		inspect: (item: Item, remove?: () => void) => void;
	} = $props();
	let items = $state(untrack(() => initial.map(({ item }) => ({ ...item }))));
	const labels = untrack(() => new Map(initial.map(({ item, label }) => [item.id, label])));
	const failedPhotos = new SvelteSet<string>();
	let hasAny = $derived(livingItems(items).length > 0);
	let active = $derived(activeItems(items));
	let done = $derived(recentlyChecked(items));

	function update(id: string, change: Partial<Item>) {
		items = items.map((item) => (item.id === id ? { ...item, ...change } : item));
	}
	function toggle(item: Item) {
		update(item.id, {
			checked: !item.checked,
			checked_at: item.checked ? null : new Date().toISOString()
		});
	}
</script>

{#snippet caption(item: Item)}
	{#if captions}<p class="fixture-caption" class:px-4={view === 'list'}>
			{labels.get(item.id)}
		</p>{/if}
{/snippet}

{#if view === 'shop'}
	<div class="shop-view">
		<ShopItems
			loaded={!loading}
			{hasAny}
			unchecked={active}
			{sort}
			categories={CATS}
			templates={TEMPLATES}
			rows={density === 'list'}
			{failedPhotos}
			oncheck={toggle}
			oninfo={(item) => inspect(item)}
			below={caption}
		/>
		<DoneItems items={done} categories={CATS} onrestore={toggle} />
	</div>
{:else}
	<ListItems
		loaded={!loading}
		{hasAny}
		{active}
		{sort}
		categories={CATS}
		templates={TEMPLATES}
		onopen={(item) => inspect(item, () => (items = items.filter((row) => row.id !== item.id)))}
		onquantity={(item, value) => update(item.id, { quantity: value })}
		below={caption}
	/>
{/if}

<style>
	.fixture-caption {
		margin: 0;
		padding-block: 4px;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
	}
</style>
