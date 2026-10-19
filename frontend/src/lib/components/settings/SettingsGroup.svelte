<!--
  One settings group ([D-269]): an aisle header, tinted and with its emoji
  plate as on a list ([D-86]), over rows that sit on the page like a list's.
  The heading is a real h2, so a screen reader can move group to group
  ([D-214]).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';
	import AisleHeader from '#lib/components/common/AisleHeader.svelte';
	import RuledRows from '#lib/components/common/RuledRows.svelte';

	let {
		title,
		icon,
		color,
		footnote,
		class: className,
		children
	}: {
		/** None for a group that says what it is by its one row (deleting the
		 *  account): a full-width rule stands in for the header. */
		title?: string;
		/** The header's emoji (in emoji-set.json's decor, so it is bundled). */
		icon?: string;
		/** A palette token, as an aisle's colour. */
		color?: string;
		/** A line under the rows: a nudge, an offline note, an error. */
		footnote?: Snippet;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<section class={cn('flex flex-col', className)}>
	{#if title}
		<AisleHeader {title} {icon} {color} sticky={false} />
	{/if}
	<RuledRows class={title ? undefined : 'border-t border-border'}>
		{@render children()}
	</RuledRows>
	{#if footnote}
		<!-- Padding on what it holds, so an empty footnote takes no room. A
		     Hint, an OfflineHint or an ErrorText: each brings its own look. -->
		<div class="px-(--row-gutter) *:pt-1 *:pb-2">
			{@render footnote()}
		</div>
	{/if}
</section>
