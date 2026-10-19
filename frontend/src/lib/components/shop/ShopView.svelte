<!--
  §9.1 shop view (tile grid), in the shared item order ([D-115]); category
  emoji and colour belong to the aisle headers ([D-37]). A tap checks an item
  off (with the undo toast); items checked on the current trip ([D-18]) sit in
  "Erledigt (N)", where a tap restores them. No adding or editing here: the
  pencil button hands off to the list view's add box (startAdding).
-->
<script lang="ts">
	import type { Item } from '#lib/db.js';
	import { listCategories, listCheckOffs, listCounts, listOpenItems } from '#lib/state/data.js';
	import { templateLookup as templates } from '#lib/state/template-lookup.js';
	import { recentlyChecked, tripEndsAt } from '#lib/sorting.js';
	import { toggleChecked } from '#lib/actions/items.js';
	import { uiDensity, itemSort } from '#lib/state/prefs.js';
	import { itemSortOrDefault } from '#lib/sorting.js';
	import { startAdding } from '#lib/components/list/start-adding.js';
	import { Now } from '#lib/state/clock.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import DoneItems from './DoneItems.svelte';
	import ProductSheet from '#lib/components/item/ProductSheet.svelte';
	import { LiveSelection } from '#lib/state/live-selection.svelte.js';
	import ShopItems from './ShopItems.svelte';
	import PrevItemsLink from '#lib/components/common/PrevItemsLink.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { SvelteSet } from 'svelte/reactivity';
	import { createTapGuard, tapPoint } from './tap-guard';

	interface Props {
		listId: string;
	}

	let { listId }: Props = $props();

	// The rows this screen shows, never the list's whole history ([D-308]).
	let openStore = $derived(listOpenItems(listId));
	let checkOffsStore = $derived(listCheckOffs(listId));
	let countsStore = $derived(listCounts(listId));
	// "Nothing on this list" vs "Dexie has not answered yet".
	// All three, so no frame shows one without the others.
	let openLoaded = $derived(openStore.loaded);
	let checkOffsLoaded = $derived(checkOffsStore.loaded);
	let countsLoaded = $derived(countsStore.loaded);
	let itemsLoaded = $derived($openLoaded && $checkOffsLoaded && $countsLoaded);
	let checkOffs = $derived($checkOffsStore);
	let counts = $derived($countsStore);
	let categoriesStore = $derived(listCategories(listId));
	let categories = $derived($categoriesStore);
	let templateLookup = $derived($templates);

	// §9.1's two empty states: no living row at all, or every row checked.
	let hasAnyItems = $derived(counts.open + counts.done > 0);
	let unchecked = $derived($openStore);
	let sort = $derived(itemSortOrDefault($itemSort));
	// The done pile empties when the trip ends ([D-18]), even on an idle screen.
	const now = new Now((at) => tripEndsAt(checkOffs, at));
	let done = $derived(recentlyChecked(checkOffs, now.value));
	// The history less the trip's rows, which are in the done pile.
	let previousCount = $derived(counts.done + counts.kept - done.length);

	// A row that leaves the grid (a co-shopper checked it) closes its sheet.
	const detail = new LiveSelection(() => unchecked);

	// [D-213], see tap-guard.ts.
	const acceptTap = createTapGuard();
	function check(item: Item, event: MouseEvent): void {
		const button = event.currentTarget;
		const tile = button instanceof HTMLElement ? button.closest('[data-item]') : null;
		if (!acceptTap(tapPoint(event), tile)) return;
		if (button instanceof HTMLElement && document.activeElement === button) {
			focusNeighbour(button, event.detail > 0);
		}
		void toggleChecked(item);
	}

	// A ticked tile leaves the grid, and its focus with it: the next Tab would
	// start again at the app bar. The tile that takes its place gets it, else
	// the one before, else "edit list" (WCAG 2.4.3). A tap moves it without
	// scrolling, so the grid does not jump under a finger.
	function focusNeighbour(button: HTMLElement, pointer: boolean): void {
		const checks = [...document.querySelectorAll<HTMLElement>('.shop-items .tile-check')];
		const at = checks.indexOf(button);
		const next =
			checks[at + 1] ?? checks[at - 1] ?? document.querySelector<HTMLElement>('.shop-add');
		next?.focus({ preventScroll: pointer });
	}

	// The list density ([D-313]). The one place density becomes structure;
	// every size arrives through the root [data-density] tokens.
	let rows = $derived($uiDensity === 'list');

	// Failed photos by item id, shared by the tiles and the sheet, so neither
	// shows a broken image (§9.2).
	let failedPhotos = new SvelteSet<string>();
</script>

<div class="shop-view flex flex-col">
	<ShopItems
		loaded={itemsLoaded}
		hasAny={hasAnyItems}
		{unchecked}
		{sort}
		{categories}
		templates={templateLookup}
		{rows}
		{failedPhotos}
		oncheck={check}
		oninfo={(item) => detail.open(item.id)}
	/>

	<!-- Above the done section: "edit list" acts on what is still to buy. -->
	<div class="flex justify-center py-3.5">
		<Button variant="outline" class="shop-add gap-2 px-5" onclick={startAdding}>
			<!-- A pencil, not a plus: it goes to edit the list ([D-213]). -->
			<Pencil />
			{t('shop_jump_to_add')}
		</Button>
	</div>

	<DoneItems items={done} {categories} onrestore={toggleChecked} />

	{#if previousCount > 0}
		<PrevItemsLink {listId} count={previousCount} />
	{/if}
</div>

<ProductSheet
	item={detail.item}
	{categories}
	templates={templateLookup}
	photoFailed={detail.id !== null && failedPhotos.has(detail.id)}
	onphotoerror={() => {
		if (detail.id !== null) failedPhotos.add(detail.id);
	}}
	onclose={detail.close}
/>
