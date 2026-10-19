<!--
  One tile of a picker grid, the aisle, emoji and colour pickers: a radio
  whose chosen state is a 2px green edge and a green tick on its corner
  ([D-319]), so the choice reads without telling the green from an aisle's own
  colour. The caller sets the tile's ground, edge and size, and the edge's
  hover, a step stronger; a colour swatch is all ground and has no content
  ([D-332]). Lint keeps every picker on it.
-->
<script lang="ts">
	import { RadioGroup } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '#lib/utils.js';

	let {
		class: className,
		children: content,
		...restProps
	}: Omit<RadioGroup.ItemProps, 'children'> & { children?: Snippet } = $props();
</script>

<RadioGroup.Item
	class={cn(
		'data-[state=checked]:relative data-[state=checked]:border-2 data-[state=checked]:border-primary-text',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		{@render content?.()}
		{#if checked}
			<span
				class="corner-mark absolute -inset-e-1.5 -top-1.5 size-5 bg-primary text-primary-foreground"
				aria-hidden="true"><Check class="size-3.5" strokeWidth={3} /></span
			>
		{/if}
	{/snippet}
</RadioGroup.Item>
