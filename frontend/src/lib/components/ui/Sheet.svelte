<!--
  The one bottom-sheet primitive, so modality behaves alike on every surface
  ([D-348]): a bits-ui dialog, the app's dialogs' own primitive, drawn at the
  bottom edge. bits-ui does the portal, focus trap and return, scroll lock,
  Escape and outside taps; ui/dialog's Root adds Back. Nothing here moves the
  sheet for the keyboard: the browser brings a focused field into view.
-->
<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import CloseButton from './CloseButton.svelte';
	import OverlayHead from './OverlayHead.svelte';

	interface Props {
		open: boolean;
		title: string;
		onclose: () => void;
		children: Snippet;
		headerActions?: Snippet;
		/** The sheet's action, on its bottom edge while the content scrolls
		 *  under it ([D-327]). */
		footer?: Snippet;
	}

	let { open, title: titleText, onclose, children, headerActions, footer }: Props = $props();
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (!o) onclose();
	}}
>
	<Dialog.Portal>
		<!-- The scrim fades as long as the sheet slides; both leave faster than
		     they came ([D-352]). -->
		<Dialog.Overlay
			class="duration-(--motion-sheet-in) data-[state=closed]:duration-(--motion-sheet-out)"
		/>
		<!-- 80dvh, not 80vh: `vh` assumes the mobile URL bar expanded, so the
		     sheet would stop short. No focus moved on open: a focused field
		     would raise the keyboard over a sheet the user only meant to read. -->
		<DialogPrimitive.Content
			data-slot="sheet-content"
			class="fixed inset-x-0 bottom-0 z-(--layer-modal) mx-auto mt-24 flex h-auto max-h-[80dvh] max-w-(--app-max) flex-col rounded-t-card border-t border-line-strong bg-surface px-4 pt-4 pb-[calc(18px+env(safe-area-inset-bottom))] text-sm text-foreground shadow-sheet outline-none duration-(--motion-sheet-in) data-[state=closed]:duration-(--motion-sheet-out) ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom"
			onOpenAutoFocus={(e) => e.preventDefault()}
		>
			<OverlayHead class="sheet-head mb-2.5" actions={headerActions}>
				<!-- A title, like a screen's ([D-278]). -->
				{#snippet title()}<Dialog.Title>{titleText}</Dialog.Title>{/snippet}
				{#snippet close()}
					<DialogPrimitive.Close>
						{#snippet child({ props })}<CloseButton {...props} />{/snippet}
					</DialogPrimitive.Close>
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
		</DialogPrimitive.Content>
	</Dialog.Portal>
</Dialog.Root>
