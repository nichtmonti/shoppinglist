<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '#lib/utils.js';
	import type { WithoutChildrenOrChild } from '#lib/utils.js';
	import DrawerOverlay from './drawer-overlay.svelte';
	import DrawerPortal from './drawer-portal.svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		...restProps
	}: DrawerPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DrawerPortal>>;
	} = $props();
</script>

<!-- 80dvh, not 80vh: `vh` assumes the mobile URL bar expanded, so the sheet
     would stop short. Unverified with the iOS keyboard up or in an installed
     PWA, so it is the right unit, not a keyboard fix. -->
<DrawerPortal {...portalProps}>
	<DrawerOverlay />
	<DrawerPrimitive.Content
		bind:ref
		data-slot="drawer-content"
		class={cn(
			'group/drawer-content fixed inset-x-0 bottom-0 z-(--layer-modal) mt-24 flex h-auto max-h-[80dvh] flex-col rounded-t-card border-t border-line-strong bg-surface text-sm text-foreground shadow-sheet',
			className
		)}
		{...restProps}
	>
		<!-- The grabber ([D-278]): shadcn's was `bg-muted`, white on the white
		     sheet, so it showed as 20px of empty space above the title. -->
		<div aria-hidden="true" class="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong"></div>
		{@render children?.()}
	</DrawerPrimitive.Content>
</DrawerPortal>
