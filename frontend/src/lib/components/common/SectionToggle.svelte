<!--
  A section that folds away ([D-326]): the shop's done items, the category
  editor's hidden ones, on bits-ui's Collapsible. Its head is a caption with
  its count and a chevron at the end, 44px to tap ([D-56]), inside a heading
  so a screen reader moving by headings reaches it (the WAI disclosure
  pattern). `content` renders the section with the props that tie it to the
  head and hide it while closed.
-->
<script lang="ts">
	import { Collapsible, type CollapsibleTriggerProps } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { cn } from '#lib/utils.js';

	let {
		label,
		count,
		open = $bindable(false),
		content,
		class: className,
		...rest
	}: Omit<CollapsibleTriggerProps, 'children' | 'child' | 'content'> & {
		label: string;
		count?: number;
		open?: boolean;
		content: Snippet<[Record<string, unknown>]>;
	} = $props();
</script>

<Collapsible.Root bind:open>
	<h2>
		<Collapsible.Trigger
			class={cn(
				'group flex min-h-11 w-full items-center gap-2.5 px-(--aisle-head-gutter) py-2.5 type-caption press-row',
				className
			)}
			{...rest}
		>
			<span>{label}</span>
			{#if count !== undefined}<span class="tabular-nums font-bold">{count}</span>{/if}
			<ChevronDown
				class="ms-auto size-4 text-faint transition-transform duration-200 group-aria-expanded:rotate-180"
				aria-hidden="true"
			/>
		</Collapsible.Trigger>
	</h2>
	<Collapsible.Content>
		{#snippet child({ props })}{@render content(props)}{/snippet}
	</Collapsible.Content>
</Collapsible.Root>
