<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
	import Check from '@lucide/svelte/icons/check';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';
	import { itemClass } from './item-class';

	let {
		ref = $bindable(null),
		class: className,
		children: content,
		...restProps
	}: Omit<DropdownMenuPrimitive.RadioItemProps, 'children'> & { children?: Snippet } = $props();
</script>

<!-- The chosen entry is marked twice, by colour and by a trailing check. -->
<DropdownMenuPrimitive.RadioItem
	bind:ref
	data-slot="dropdown-menu-radio-item"
	class={cn(itemClass, 'data-[state=checked]:text-primary-text', className)}
	{...restProps}
>
	{#snippet children({ checked })}
		{@render content?.()}
		{#if checked}<Check class="size-4.5 ms-auto" />{/if}
	{/snippet}
</DropdownMenuPrimitive.RadioItem>
