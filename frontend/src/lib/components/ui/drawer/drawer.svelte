<!--
  `shouldScaleBackground` defaults off here (shadcn ships it on): with a
  `[data-vaul-drawer-wrapper]` it would scale the whole page behind a
  backdrop-filtered overlay and re-raster it on every animation frame (see
  drawer-overlay.svelte).
-->
<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { backClosable } from '#lib/history-layers.svelte.js';

	let {
		shouldScaleBackground = false,
		open = $bindable(false),
		activeSnapPoint = $bindable(null),
		onOpenChange,
		...restProps
	}: DrawerPrimitive.RootProps = $props();

	// Open, it is a history entry, so back closes it (#lib/history-layers).
	// Setting `open` here does not fire onOpenChange, so report the close.
	backClosable(
		() => open,
		() => {
			open = false;
			onOpenChange?.(false);
		}
	);
</script>

<DrawerPrimitive.Root
	{shouldScaleBackground}
	bind:open
	bind:activeSnapPoint
	{onOpenChange}
	{...restProps}
/>
