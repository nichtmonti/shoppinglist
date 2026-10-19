<!--
  A screen or a view waiting with words ([D-324]): EmptyState's composition
  with the spinner for its picture, the title and a line of body. Its own part,
  without EmptyState's emoji: the sign-in screen waits on the boot path, where
  the inlined emoji set would cost ~33 KiB gzipped ([D-186], [D-203]).
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.js';
	import Spinner from './Spinner.svelte';
	import { EMPTY_STATE_CLASS } from './empty-state';

	let {
		title,
		body,
		class: className,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { title?: string; body?: string } = $props();
</script>

<div class={cn(EMPTY_STATE_CLASS, className)} aria-busy="true" {...rest}>
	<Spinner class="mb-3" />
	{#if title}<h2 class="type-heading text-foreground">{title}</h2>{/if}
	{#if body}<p class="mt-1">{body}</p>{/if}
</div>
