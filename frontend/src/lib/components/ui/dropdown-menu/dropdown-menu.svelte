<script lang="ts">
	import { backClosable } from '#lib/history-layers.svelte.js';
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';

	let {
		open = $bindable(false),
		onOpenChange,
		...restProps
	}: DropdownMenuPrimitive.RootProps = $props();

	// Back closes it, reporting the close as Escape would (see drawer.svelte).
	backClosable(
		() => open,
		() => {
			open = false;
			onOpenChange?.(false);
		}
	);
</script>

<DropdownMenuPrimitive.Root bind:open {onOpenChange} {...restProps} />
