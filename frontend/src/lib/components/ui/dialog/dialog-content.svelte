<script lang="ts">
	import { dialogSurface } from '#lib/components/ui/dialog/dialog-surface.js';
	import { floatSurface } from '#lib/components/ui/card/card-surface.js';
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '#lib/utils.js';
	import * as Dialog from './index.js';
	import DialogPortal from './dialog-portal.svelte';
	import type { Snippet } from 'svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
		children: Snippet;
	} = $props();
</script>

<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(floatSurface, dialogSurface, className)}
		{...restProps}
	>
		{@render children?.()}
	</DialogPrimitive.Content>
</DialogPortal>
