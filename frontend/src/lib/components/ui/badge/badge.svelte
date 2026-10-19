<!--
  A small pill of state or count on a card, a row or a header ([D-327]): the
  home card's unsynced count, the share sheet's "you", an aisle's count.
  One shape; the tone says what kind: grey, the green of "you" and
  "synced", the amber of "waiting", or the aisle's own colour (its `--c`).
-->
<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	const TONES = {
		neutral: 'border-border text-muted-foreground',
		primary: 'border-primary-line bg-primary-soft text-primary-text',
		amber: 'border-amber-line bg-amber-soft text-amber',
		category: 'cat-surface-14 cat-border-28 cat-text-65'
	} as const;

	let {
		ref = $bindable(null),
		tone = 'neutral',
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> & { tone?: keyof typeof TONES } = $props();
</script>

<span
	bind:this={ref}
	data-slot="badge"
	class={cn(
		'inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-micro font-bold whitespace-nowrap tabular-nums',
		TONES[tone],
		className
	)}
	{...restProps}
>
	{@render children?.()}
</span>
