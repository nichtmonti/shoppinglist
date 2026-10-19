<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
	import { cn } from '#lib/utils.js';
	import { itemClass } from './item-class';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'default',
		...restProps
	}: DropdownMenuPrimitive.ItemProps & {
		variant?: 'default' | 'destructive';
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	data-slot="dropdown-menu-item"
	data-variant={variant}
	class={cn(
		itemClass,
		'data-[variant=destructive]:text-danger data-[variant=destructive]:data-highlighted:bg-danger-soft data-[variant=destructive]:data-highlighted:text-danger',
		className
	)}
	{...restProps}
/>
