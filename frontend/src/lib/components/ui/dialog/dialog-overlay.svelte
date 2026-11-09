<!--
  The one scrim behind every dialog and sheet, in `--overlay` ([D-314]).
  The blur is kept cheap: `backdrop-filter` re-reads and blurs the page beneath
  on every frame of the open animation. One full-viewport pass at `blur-xs` is
  affordable, two are not: do not stack another overlay, and do not raise the
  radius without measuring the open animation.
-->
<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		'bg-overlay duration-100 supports-backdrop-filter:backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fixed inset-0 isolate z-(--layer-modal)',
		className
	)}
	{...restProps}
/>
