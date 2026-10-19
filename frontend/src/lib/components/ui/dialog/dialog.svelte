<script lang="ts">
	import { backClosable } from '#lib/history-layers.svelte.js';
	import { Dialog as DialogPrimitive } from 'bits-ui';

	let { open = $bindable(false), onOpenChange, ...restProps }: DialogPrimitive.RootProps = $props();

	// Back closes it, reporting the close as Escape would (see drawer.svelte).
	backClosable(
		() => open,
		() => {
			open = false;
			onOpenChange?.(false);
		}
	);
</script>

<DialogPrimitive.Root bind:open {onOpenChange} {...restProps} />
