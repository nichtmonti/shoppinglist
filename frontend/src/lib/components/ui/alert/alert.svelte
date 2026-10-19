<!--
  A notice in the page's flow (the install banner): a card, as the lists
  beside it are ([D-316], [D-317]). The caller places it.
-->
<script lang="ts">
	import { cardSurface } from '#lib/components/ui/card/card-surface.js';
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="alert"
	role="alert"
	class={cn(cardSurface, 'grid gap-2.5 p-3.5 text-start', className)}
	{...restProps}
>
	{@render children?.()}
</div>
