<!--
  A screen's actions pinned at its foot ([D-328]): an arrange mode's "Fertig",
  the import review's confirm. It stays at the foot however long the screen,
  on the page's own background without a bar of its own ([D-239]); opaque, so
  a row scrolled under it does not show, and on the bar layer, so no row's own
  layer paints over it ([D-317]). Its blocks are 8px apart.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let { class: className, children }: { class?: string; children: Snippet } = $props();
</script>

<div
	class={cn(
		'sticky bottom-0 z-(--layer-bar) flex flex-col gap-2 bg-background px-(--row-gutter) pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]',
		className
	)}
>
	{@render children()}
</div>
