<!--
  Rows ruled like a list's (§9.1): each row after the first carries a
  hairline from the content column to the far edge, never a box ([D-269]).
  `inset` is where the line starts: the row gutter on a page, the text
  column after a leading plate (`--row-rule-inset`). In a sheet, `flush`
  lets the rows (SettingsRow's `flush`) reach into the sheet's slack and
  starts the line at it. The one way rows on a page are separated ([D-326]).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.js';

	let {
		flush = false,
		inset = flush ? '0.375rem' : 'var(--row-gutter)',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & {
		flush?: boolean;
		inset?: string;
		children: Snippet;
	} = $props();
</script>

<div
	{...rest}
	class={cn('ruled-rows flex flex-col', flush && '-mx-1.5', className)}
	style="--rule-inset: {inset}"
>
	{@render children()}
</div>
