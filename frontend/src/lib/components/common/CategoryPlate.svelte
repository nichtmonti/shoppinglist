<!--
  A category's icon on its tinted plate ([D-326]), in one of four sizes:
  `item` (38px) leads an item's row, as on the list; `row` (34px) leads any
  other row; `head` (26px) sits in an aisle or group header or beside a
  fact; `inline` (20px) sits in a line of text. `band` takes the stronger
  tint a plate needs on a tinted header band. The tint is the `--c` the
  caller sets (categoryStyle), here through `style` or on an ancestor.
-->
<script lang="ts">
	import { cn } from '#lib/utils.js';
	import CategoryIcon from './CategoryIcon.svelte';

	const SIZES = {
		item: { box: 'size-9.5', chip: 2.375 },
		row: { box: 'size-8.5', chip: 2.125 },
		head: { box: 'size-6.5', chip: 1.625 },
		inline: { box: 'size-5', chip: 1.25 }
	} as const;

	let {
		icon,
		size = 'row',
		band = false,
		class: className,
		style
	}: {
		icon: string | null | undefined;
		size?: keyof typeof SIZES;
		band?: boolean;
		class?: string;
		style?: string;
	} = $props();
</script>

<span
	class={cn(
		'grid flex-none place-items-center rounded-chip border',
		band ? 'cat-plate-18 cat-border-30' : 'cat-plate-14 cat-border-28',
		SIZES[size].box,
		className
	)}
	{style}
	aria-hidden="true"><CategoryIcon {icon} chip={SIZES[size].chip} /></span
>
