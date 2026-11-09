<script lang="ts">
	import { backClosable } from '#lib/history-layers.svelte.js';
	import { Dialog as DialogPrimitive } from 'bits-ui';

	let { open = $bindable(false), onOpenChange, ...restProps }: DialogPrimitive.RootProps = $props();

	// Open, it is a history entry, so Back closes it (#lib/history-layers),
	// reporting the close as Escape would: setting `open` here does not fire
	// onOpenChange.
	backClosable(
		() => open,
		() => {
			open = false;
			onOpenChange?.(false);
		}
	);
</script>

<DialogPrimitive.Root bind:open {onOpenChange} {...restProps} />
