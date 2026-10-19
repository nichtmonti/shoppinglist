<!--
  The head of a section that folds away ([D-326]): the shop's done items, the
  category editor's hidden ones. A caption with its count and a chevron at the
  end, 44px to tap ([D-56]), inside a heading so a screen reader moving by
  headings reaches it (the WAI disclosure pattern). The caller renders the
  section under it with `id={controls}` and `hidden={!open}`.
-->
<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { cn } from '#lib/utils.js';

	let {
		label,
		count,
		open = $bindable(false),
		controls,
		class: className,
		...rest
	}: HTMLButtonAttributes & {
		label: string;
		count?: number;
		open?: boolean;
		controls: string;
	} = $props();
</script>

<h2>
	<button
		type="button"
		class={cn(
			'group flex min-h-11 w-full items-center gap-2.5 px-(--aisle-head-gutter) py-2.5 type-caption press-row',
			className
		)}
		aria-expanded={open}
		aria-controls={controls}
		onclick={() => (open = !open)}
		{...rest}
	>
		<span>{label}</span>
		{#if count !== undefined}<span class="tabular-nums font-bold">{count}</span>{/if}
		<ChevronDown
			class="ms-auto size-4 text-faint transition-transform duration-200 group-aria-expanded:rotate-180"
			aria-hidden="true"
		/>
	</button>
</h2>
