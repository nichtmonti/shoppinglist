<!--
  A screen or a view with nothing to show yet ([D-324]): the one composition.
  A picture whenever the screen holds nothing else (an emoji on its plate; a
  wait with words is Waiting, the spinner in the same place), then the title (a heading, under the screen's
  h1), a line of body, and the actions, stacked and full width. With nothing
  given it is the blank, busy placeholder of a screen still reading its data.
  Keeps the `.emptystate` hook the tests select.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.js';
	import Emoji from './Emoji.svelte';
	import { EMPTY_STATE_CLASS } from './empty-state';

	let {
		emoji,
		title,
		body,
		actions,
		children,
		class: className,
		...rest
	}: HTMLAttributes<HTMLDivElement> & {
		emoji?: string;
		title?: string;
		body?: string;
		actions?: Snippet;
		/** Under everything: a note such as "needs a connection". */
		children?: Snippet;
	} = $props();
</script>

<div class={cn(EMPTY_STATE_CLASS, className)} {...rest}>
	{#if emoji}
		<span class="icon-plate mb-3 grid size-12 place-items-center rounded-chip border border-border"
			><Emoji {emoji} size={2.25} /></span
		>
	{/if}
	{#if title}<h2 class="type-heading text-foreground">{title}</h2>{/if}
	{#if body}<p class="mt-1">{body}</p>{/if}
	{#if actions}
		<div class="mt-5 flex w-full max-w-(--focus-max) flex-col gap-2">{@render actions()}</div>
	{/if}
	{@render children?.()}
</div>
