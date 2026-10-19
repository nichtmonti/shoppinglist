<!--
  §9.1: the free-text quantity ([D-20]) as a display-only badge, for the plain
  tile, the photo tile, the list density's tinted row and the done row
  ([D-86]). On the tinted row it is the aisle header's count chip, opaque, so
  the row's wash never stacks under its text ([D-329]). The tile chips are a step
  larger: in the aisle the quantity is read at arm's length ([D-213]). Inside
  a tile the chip carries its paint only; position and truncation are
  shop-tile.css's, which a utility here would outrank ([D-83]); outside a
  tile (the add field's candidates, [D-332]) the caller places it with
  `class`. Renders nothing for an empty quantity. The editable control is
  QuantityControl.
-->
<script lang="ts">
	import { cn } from '#lib/utils.js';

	interface Props {
		quantity: string;
		variant?: 'tile' | 'tile-photo' | 'tile-category' | 'plain';
		/** A tile hides its text layers from assistive tech: its check
		 *  button's label names the item ([D-83]). */
		'aria-hidden'?: 'true';
		/** Placement outside a tile; never inside one ([D-83]). */
		class?: string;
	}

	let { quantity, variant = 'tile', 'aria-hidden': ariaHidden, class: className }: Props = $props();
</script>

{#if quantity}
	<span
		class={cn(
			'qty tabular-nums font-demi',
			variant === 'tile-photo'
				? 'text-qty text-(--tile-photo-ink) bg-(--tile-photo-chip-bg) rounded-chip px-1.5 py-0.5'
				: variant === 'tile-category'
					? 'text-qty cat-text-65 cat-surface-14 rounded-chip px-1.5 py-0.5'
					: variant === 'tile'
						? 'text-qty text-muted-foreground bg-tint-strong rounded-chip px-1.5 py-0.5'
						: 'text-qty self-center text-muted-foreground',
			className
		)}
		dir="auto"
		aria-hidden={ariaHidden}>{quantity}</span
	>
{/if}
