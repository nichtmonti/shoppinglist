<!--
  A sheet's or a dialog's head ([D-327]): its title, any actions beside it,
  and the ✕, in one row as tall as the ✕.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let {
		title,
		actions,
		close,
		class: className
	}: { title: Snippet; actions?: Snippet; close: Snippet; class?: string } = $props();
</script>

<div class={cn('overlay-head flex min-h-10 items-center gap-2', className)}>
	<div class="min-w-0 flex-1">{@render title()}</div>
	<div class="sheet-actions flex items-center gap-1">
		{@render actions?.()}
		{@render close()}
	</div>
</div>
