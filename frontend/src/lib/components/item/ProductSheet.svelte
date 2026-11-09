<!--
  §9.1 the shop view's read-only product sheet, opened by a tile's ⓘ door.
  Editing is ItemDetailSheet's. Outside components/shop/ so a change here
  does not run the tile audit.
-->
<script lang="ts">
	import type { CategoryTemplate, Item, ListCategory } from '#lib/db.js';
	import { displayName } from '#lib/item-name.js';
	import { categoryName, categoryOf, categoryStyle } from '#lib/categories.js';
	import { t } from '#lib/i18n/index.js';
	import { openPhotoViewer } from '#lib/components/shop/photo-lightbox.js';
	import ProductMedia from '#lib/components/common/ProductMedia.svelte';
	import CategoryPlate from '#lib/components/common/CategoryPlate.svelte';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import { backClosable } from '#lib/history-layers.svelte.js';
	import { Kept } from '#lib/state/kept.svelte.js';

	let {
		item,
		categories,
		templates,
		photoFailed,
		onphotoerror,
		onclose
	}: {
		/** The open item, or null for a closed sheet. */
		item: Item | null;
		categories: ListCategory[];
		templates: Map<string, CategoryTemplate>;
		/** The shop view's per-item photo failure, shared with the tile (§9.2). */
		photoFailed: boolean;
		onphotoerror: () => void;
		onclose: () => void;
	} = $props();

	// What the sheet shows, kept while it slides closed.
	const shown = new Kept(() => item);
	let category = $derived(shown.value ? categoryOf(shown.value, categories) : undefined);

	let lightboxOpen = $state(false);
	let closeViewer: (() => void) | null = null;
	// The viewer is a layer of its own ([D-230]): the sheet's entry goes while
	// it is open, so without this back would leave the screen under it.
	backClosable(
		() => lightboxOpen,
		() => closeViewer?.()
	);
</script>

<!-- The sheet unmounts while the photo viewer is open, since two focus traps
     fight ([D-94]); `item` stays set, so it returns intact. -->
<Sheet open={item !== null && !lightboxOpen} title={t('shop_product_details')} {onclose}>
	{#if shown.value}
		{@const detail = shown.value}
		<div class="product-details flex flex-col gap-2.5">
			<ProductMedia
				url={detail.image_url}
				name={displayName(detail)}
				barcode={detail.barcode}
				failed={photoFailed}
				onerror={onphotoerror}
				onzoom={() =>
					void openPhotoViewer(detail.image_url ?? '', displayName(detail), {
						onopen: (close) => {
							closeViewer = close;
							lightboxOpen = true;
						},
						onclose: () => {
							closeViewer = null;
							lightboxOpen = false;
						}
					})}
				photoClass="block w-full"
			/>
			<h2 class="type-heading" dir="auto">{displayName(detail)}</h2>
			{#if category}
				<p class="flex items-center gap-2" data-testid="detail-category">
					<CategoryPlate icon={category.icon} size="head" style={categoryStyle(category.color)} />
					{categoryName(category, templates)}
				</p>
			{/if}
			{#if detail.quantity}<p>{t('common_quantity')}: {detail.quantity}</p>{/if}
			{#if detail.note}<p dir="auto">{detail.note}</p>{/if}
		</div>
	{/if}
</Sheet>
