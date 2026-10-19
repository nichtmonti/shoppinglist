<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.js';
	import { cardSurface } from './card-surface.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div bind:this={ref} data-slot="card" class={cn(cardSurface, className)} {...restProps}>
	{@render children?.()}
</div>
