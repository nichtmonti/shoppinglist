<!--
  The one app bar ([D-272]): the way back where there is one, the sync chip
  ([D-130]), the title block, and the actions pinned to the right edge. One
  geometry on every screen (one 56px row), so moving between screens moves
  nothing that both show: the chip, the title, the sort button and the last
  button keep their place, and the icons one size (`bar-icon size-5.5`, 22px
  inside the 40px buttons) and every glyph one line weight ([D-276]). The
  icons are the text colour; green in the bar is the chip's and the chosen
  view's, which say a state. The title keeps its line and
  truncates; only below 15rem (text at 150% and up on a phone) does it take
  its own line under the buttons, or it would be left ~40px ([D-90]).
  `below` is what a screen hangs under the row inside the bar: the list's
  view switch.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		back,
		chip,
		title,
		actions,
		below
	}: {
		back?: Snippet;
		chip?: Snippet;
		title: Snippet;
		actions?: Snippet;
		below?: Snippet;
	} = $props();
</script>

<header class="app-bar bg-surface border-b border-border">
	<!-- The padding is on the container, so the 15rem query measures the row's
	     content, as the home's bar always did. -->
	<div class="@container px-4">
		<div class="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
			{@render back?.()}{@render chip?.()}
			<!-- A two-line block's line boxes leave 1.4px more below than above:
			     1px down centres its ink on the icons' line. -->
			<div
				class="min-w-0 flex-1 has-[>*+*]:translate-y-px @max-[15rem]:order-last @max-[15rem]:basis-full"
			>
				{@render title()}
			</div>
			{#if actions}
				<!-- 8px into the margin, so the icons' centres sit 28px from the
				     edge and their ink mirrors the 16px on the left. -->
				<div class="ms-auto -me-2 flex shrink-0 items-center gap-2">{@render actions()}</div>
			{/if}
		</div>
	</div>
	{@render below?.()}
</header>

<style>
	/* The size is the icon's own `size-5.5` class: the button primitive sizes
	   any svg without a size- class down to 16px. */
	.app-bar :global(.bar-icon) {
		display: block;
		flex-shrink: 0;
	}
	/* One line weight for every glyph in the bar, whatever size it is drawn at
	   ([D-276]): the 22px buttons, the chip's 16px cloud, the title's ▾ and
	   the view switch's icons. A stroke in viewBox units scales with the
	   icon, so the same `2` came out 2.06px on one and 1.25px on another;
	   non-scaling-stroke draws it at its own width. In rem, so it follows the
	   text size like the icons do. */
	.app-bar :global(svg) {
		stroke-width: var(--bar-ink);
	}
	.app-bar :global(svg :is(path, circle, line, polyline, polygon, rect, ellipse)) {
		vector-effect: non-scaling-stroke;
	}
	.app-bar {
		--bar-ink: 0.109375rem; /* 1.75px */
	}
</style>
