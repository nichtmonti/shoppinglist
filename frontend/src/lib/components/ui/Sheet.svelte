<!--
  The one bottom-sheet primitive, so modality behaves alike on every surface.
  Over shadcn's Drawer (vaul-svelte, [D-54]): portal, focus trap and return,
  scroll lock, Escape and drag-to-dismiss.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import CloseButton from './CloseButton.svelte';
	import OverlayHead from './OverlayHead.svelte';
	import {
		Drawer,
		DrawerContent,
		DrawerTitle,
		DrawerClose
	} from '#lib/components/ui/drawer/index.js';

	interface Props {
		open: boolean;
		title: string;
		onclose: () => void;
		children: import('svelte').Snippet;
		headerActions?: Snippet;
		/** The sheet's action, on its bottom edge while the content scrolls
		 *  under it ([D-327]). */
		footer?: Snippet;
	}

	let { open, title: titleText, onclose, children, headerActions, footer }: Props = $props();
</script>

<Drawer
	bind:open
	onOpenChange={(o) => {
		if (!o) onclose();
	}}
>
	<!-- DrawerContent brings its own portal and overlay; do not wrap it in
	     another, since each backdrop-blur layer costs a full-screen pass. -->
	<DrawerContent
		class="mx-auto max-w-(--app-max) px-4 pt-2.5 pb-[calc(18px+env(safe-area-inset-bottom))]"
	>
		<OverlayHead class="sheet-head mb-2.5" actions={headerActions}>
			<!-- A title, like a screen's ([D-278]): it was a small grey caps label,
			     quieter than the fields under it. -->
			{#snippet title()}<DrawerTitle>{titleText}</DrawerTitle>{/snippet}
			{#snippet close()}
				<DrawerClose>
					{#snippet child({ props })}<CloseButton {...props} />{/snippet}
				</DrawerClose>
			{/snippet}
		</OverlayHead>
		<!-- `overflow-y: auto` clips horizontally too (overflow-x computes to
		     auto), which would cut off full-width children's focus rings. The
		     padding slack, taken back as margin, keeps them clear of the clip
		     edge without moving anything. -->
		<!-- Its blocks 16px apart ([D-327]). -->
		<div class="sheet-body -mx-1.5 -mt-1.5 flex flex-col gap-4 overflow-y-auto p-1.5">
			{@render children()}
			{#if footer}
				<!-- Pinned where the scroll ends, so the action shows while long
				     content (a picker) scrolls under it; 6px down takes back the
				     body's slack. -->
				<div
					class="sheet-foot sticky -bottom-1.5 z-1 -mx-1.5 -mb-1.5 border-t border-border bg-surface px-1.5 pt-3 pb-1.5"
				>
					{@render footer()}
				</div>
			{/if}
		</div>
	</DrawerContent>
</Drawer>
