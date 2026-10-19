<script lang="ts">
	import { backClosable } from '#lib/history-layers.svelte.js';
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

	let {
		open = $bindable(false),
		onOpenChange,
		...restProps
	}: AlertDialogPrimitive.RootProps = $props();

	// Back closes it, reporting the close as Escape would (see drawer.svelte).
	backClosable(
		() => open,
		() => {
			open = false;
			onOpenChange?.(false);
		}
	);
</script>

<AlertDialogPrimitive.Root bind:open {onOpenChange} {...restProps} />
