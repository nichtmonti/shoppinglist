<!--
  §9.1 "List view (rows) — planning & editing": the active items in the shared
  item order ([D-115]) under the pinned add box, with the item sheet.
-->
<script lang="ts">
	import {
		listCategories,
		listCheckOffs,
		listCounts,
		listOpenItems,
		listRememberedItems
	} from '#lib/state/data.js';
	import { templateLookup } from '#lib/state/template-lookup.js';
	import { itemSort } from '#lib/state/prefs.js';
	import { Now } from '#lib/state/clock.svelte.js';
	import { itemSortOrDefault, livingItems, recentlyChecked, tripEndsAt } from '#lib/sorting.js';
	import { LiveSelection } from '#lib/state/live-selection.svelte.js';
	import AddBar from '#lib/components/add/AddBar.svelte';
	import ListItems from './ListItems.svelte';
	import ItemDetailSheet from './ItemDetailSheet.svelte';
	import PrevItemsLink from '#lib/components/common/PrevItemsLink.svelte';
	import { scrollBehavior } from '#lib/state/motion.js';
	import { removeItem } from '#lib/actions/items.js';
	import { nameTakenBy } from '#lib/dedup.js';
	import type { Item } from '#lib/db.js';

	interface Props {
		listId: string;
	}

	let { listId }: Props = $props();

	// The rows this screen shows, never the list's whole history ([D-308]).
	let openStore = $derived(listOpenItems(listId));
	let checkOffsStore = $derived(listCheckOffs(listId));
	let countsStore = $derived(listCounts(listId));
	let categoriesStore = $derived(listCategories(listId));

	// Distinguishes "nothing on this list" from "Dexie has not answered yet".
	// All three, so no frame shows one without the others.
	let openLoaded = $derived(openStore.loaded);
	let checkOffsLoaded = $derived(checkOffsStore.loaded);
	let countsLoaded = $derived(countsStore.loaded);
	let itemsLoaded = $derived($openLoaded && $checkOffsLoaded && $countsLoaded);
	let active = $derived($openStore);
	let checkOffs = $derived($checkOffsStore);
	let counts = $derived($countsStore);
	let categories = $derived($categoriesStore);
	let templatesMap = $derived($templateLookup);

	let hasAnyItems = $derived(counts.open + counts.done > 0);
	// The count must move when the trip ends ([D-18]) even if no row does.
	const now = new Now((at) => tripEndsAt(checkOffs, at));
	// The history less the trip's rows, as the shop view counts it.
	let previousCount = $derived(
		counts.done + counts.kept - recentlyChecked(checkOffs, now.value).length
	);

	let sort = $derived(itemSortOrDefault($itemSort));

	// The item sheet (§9.1); a row that leaves the plan closes it.
	const detail = new LiveSelection(() => active);

	// A rename into a name another row on the list answers to (§8.3 merges
	// only an add, so the list would show it twice). The rows it checks are
	// read only while the sheet is open.
	let sheetOpen = $derived(detail.id !== null);
	let living: Item[] = [];
	$effect(() => {
		if (!sheetOpen) return;
		return listRememberedItems(listId).subscribe((rows) => (living = livingItems(rows)));
	});
	function nameTaken(name: string, item: Item): boolean {
		return nameTakenBy(living, name, item.id);
	}

	// The add box's dedup jump (§9.1).
	function handleJump(itemId: string): void {
		const el = [...(listRoot?.querySelectorAll<HTMLElement>('[data-item]') ?? [])].find(
			(slot) => slot.dataset.item === itemId
		);
		if (!el) return;
		// A JS argument, which app.css's reduced-motion rule cannot reach.
		el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
	}

	// The add bar's height feeds --addbar-h (where aisle headers stick and the
	// dropdown starts). Measured, because zoom and the touch-target floor change
	// it, and a stale value hides part of every stuck aisle header.
	let listRoot: HTMLDivElement | null = $state(null);
	let addbarHeight = $state(0);
</script>

<div
	class="block"
	bind:this={listRoot}
	style:--addbar-h={addbarHeight ? `${addbarHeight}px` : undefined}
>
	<AddBar {listId} onjump={handleJump} bind:height={addbarHeight} />

	<ListItems
		loaded={itemsLoaded}
		hasAny={hasAnyItems}
		{active}
		{sort}
		{categories}
		templates={templatesMap}
		onopen={(item) => detail.open(item.id)}
		onremove={(item) => void removeItem(item)}
	/>

	<!-- Always shown: this is the only route to the screen, which has its own
	     empty state for a list with nothing aged out yet ([D-18]). -->
	<PrevItemsLink {listId} count={previousCount} always />

	<ItemDetailSheet
		item={detail.item}
		{categories}
		templates={templatesMap}
		onclose={detail.close}
		{nameTaken}
	/>
</div>
