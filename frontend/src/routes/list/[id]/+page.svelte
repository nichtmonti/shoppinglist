<!--
  The two views of one list (§9.1). Which one renders is a device preference,
  not a route, so switching pushes no history.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { listView } from '#lib/state/prefs.js';
	import ShopView from '#lib/components/shop/ShopView.svelte';
	import ListView from '#lib/components/list/ListView.svelte';
	import EmptyState from '#lib/components/common/EmptyState.svelte';

	let listId = $derived(page.params.id ?? '');
	// Wait for the pref: its fallback 'shop' would flash first ([D-196]).
	const viewLoaded = listView.loaded;
</script>

<!-- Keyed by the list: the switcher changes lists without leaving the route,
     and nothing typed or opened on one list belongs to the next. -->
{#key listId}
	{#if !$viewLoaded}
		<EmptyState aria-busy="true" />
	{:else if $listView === 'shop'}
		<ShopView {listId} />
	{:else}
		<ListView {listId} />
	{/if}
{/key}
