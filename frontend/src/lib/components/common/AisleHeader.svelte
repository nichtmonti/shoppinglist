<!--
  §9.1: the colour-tinted aisle header over a group, in both views ([D-86]),
  and over a settings group ([D-269]).
  Padding follows the density tokens (--aisle-py) and --aisle-head-gutter,
  deliberately 2px inside the rows ([D-129]). It sticks at --addbar-h (0 in
  the shop view). Layer 5 keeps it above every tile door (4); the add bar's
  dropdown clears it through .addwrap's bar layer ([D-131]).

  Ruled above and below ([D-332]).

  The count pill is cat-text-65, not -80: it stacks on the row's tint, and at
  80 several palette colours miss 4.5:1. design-tokens.test.ts pins the
  layers and the ratios.
-->
<script lang="ts">
	import { categoryStyle } from '#lib/categories.js';
	import { cn } from '#lib/utils.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import CategoryPlate from '#lib/components/common/CategoryPlate.svelte';

	interface Props {
		title: string;
		icon: string | null | undefined;
		/** A palette token: the aisle's colour, or a settings group's. */
		color: string | null | undefined;
		/** How many rows the group holds; a settings group shows none. */
		count?: number;
		/** Off for a settings group, which does not stick. */
		sticky?: boolean;
	}

	let { title, icon, color, count, sticky = true }: Props = $props();
</script>

<header
	class={cn(
		'cat-head z-(--layer-sticky) flex items-center gap-2 px-(--aisle-head-gutter) py-(--aisle-py) cat-surface-12 border-y cat-border-26',
		sticky && 'sticky top-(--addbar-h)'
	)}
	style={categoryStyle(color)}
>
	<CategoryPlate {icon} size="head" band class="aisle-emoji" />
	<!-- A real heading ([D-213]): screen readers jump group to group by it.
	     Level 2 under the screen's own h1. -->
	<h2 class="cat-head-name type-section cat-text-70">{title}</h2>
	{#if count !== undefined}
		<Badge tone="category" class="cat-head-count ms-auto">{count}</Badge>
	{/if}
</header>
