<script lang="ts">
	import { dialogSurface } from '#lib/components/ui/dialog/dialog-surface.js';
	import { floatSurface } from '#lib/components/ui/card/card-surface.js';
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
	import { cn, type WithoutChild, type WithoutChildrenOrChild } from '#lib/utils.js';
	import AlertDialogOverlay from './alert-dialog-overlay.svelte';
	import AlertDialogPortal from './alert-dialog-portal.svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		...restProps
	}: WithoutChild<AlertDialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof AlertDialogPortal>>;
	} = $props();
</script>

<AlertDialogPortal {...portalProps}>
	<AlertDialogOverlay />
	<AlertDialogPrimitive.Content
		bind:ref
		data-slot="alert-dialog-content"
		class={cn(floatSurface, dialogSurface, className)}
		{...restProps}
	/>
</AlertDialogPortal>
