<!--
  A scanned product's photo, its credit and its barcode, as both item sheets
  show them: one block, one rhythm. Renders nothing for an item with neither.
-->
<script lang="ts">
	import { cn } from '#lib/utils.js';
	import ProductPhoto from './ProductPhoto.svelte';
	import BarcodeLine from './BarcodeLine.svelte';

	let {
		url,
		name,
		barcode,
		failed,
		onerror,
		onzoom,
		photoClass,
		class: className
	}: {
		url: string | null;
		/** The item's display name, for the zoom door's label. */
		name: string;
		barcode: string | null | undefined;
		failed: boolean;
		onerror: () => void;
		onzoom?: () => void;
		photoClass?: string;
		class?: string;
	} = $props();
</script>

{#if (url && !failed) || barcode}
	<div class={cn('product-media flex flex-col gap-1.5', className)}>
		<ProductPhoto {url} {name} {failed} {onerror} {onzoom} class={photoClass} />
		{#if barcode}<BarcodeLine {barcode} />{/if}
	</div>
{/if}
