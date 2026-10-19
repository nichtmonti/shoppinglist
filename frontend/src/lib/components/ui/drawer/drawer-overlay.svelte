<!--
  The one scrim behind every Sheet, in the dialogs' colour (`--overlay`,
  [D-314]). It is set here, not in a consumer: DrawerContent portals this
  overlay itself, so restyling it from outside would take a second overlay.

  The blur is kept cheap: `backdrop-filter` re-reads and blurs the page beneath
  on every frame of the open animation. One full-viewport pass at `blur-xs` is
  affordable, two are not: do not stack another overlay, and do not raise the
  radius without measuring the open animation.
-->
<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DrawerPrimitive.OverlayProps = $props();
</script>

<DrawerPrimitive.Overlay
	bind:ref
	data-slot="drawer-overlay"
	class={cn(
		'bg-overlay supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-(--layer-modal)',
		className
	)}
	{...restProps}
/>
