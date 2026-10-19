<!--
  A scanned product's photo, in an item sheet or the scan dialog, with the
  credit Open Food Facts' terms ask for (§9.2). Renders nothing once the photo failed to load. With
  `onzoom` it opens the fullscreen viewer ([D-94]).
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { cn } from '#lib/utils.js';
	import Hint from './Hint.svelte';
	import TextLink from './TextLink.svelte';

	let {
		url,
		name,
		failed,
		onerror,
		onzoom,
		class: className
	}: {
		url: string | null;
		/** The item's display name, for the zoom door's label. */
		name: string;
		failed: boolean;
		onerror: () => void;
		onzoom?: () => void;
		/** Extra classes on the image (spacing, sizing). */
		class?: string;
	} = $props();
</script>

{#if url && !failed}
	{#if onzoom}
		<button
			type="button"
			class="photo-zoom block w-full cursor-zoom-in"
			onclick={onzoom}
			aria-label={t('shop_photo_enlarge', { name })}
		>
			{@render photo(url)}
		</button>
	{:else}
		{@render photo(url)}
	{/if}
	<Hint size="micro" class="product-attribution">
		<TextLink href="https://world.openfoodfacts.org">{t('scan_attribution')}</TextLink>
		·
		<TextLink href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</TextLink>
	</Hint>
{/if}

{#snippet photo(src: string)}
	<img
		{src}
		alt=""
		class={cn(
			'product-image max-w-full h-(--sheet-img-h) object-contain rounded-card bg-surface-2',
			className
		)}
		{onerror}
	/>
{/snippet}
