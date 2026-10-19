<!--
  A checkbox in the app's state language ([D-314]): checked is the soft green
  a chosen option wears ([D-281]), with the done row's tick; unchecked is the
  secondary's white with a firm edge ([D-284]). The platform's box was solid
  green, the primary action's colour.
-->
<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from 'bits-ui';
	import Check from '@lucide/svelte/icons/check';
	import { cn, type WithoutChildrenOrChild } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	bind:checked
	data-slot="checkbox"
	class={cn(
		'grid size-5 shrink-0 cursor-pointer place-items-center rounded-chip border border-faint bg-surface-2 text-primary-text disabled:cursor-not-allowed disabled:border-transparent disabled:bg-tint-strong data-[state=checked]:border-primary-line data-[state=checked]:bg-primary-soft disabled:data-[state=checked]:text-muted-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		{#if checked}<Check class="size-3.5" strokeWidth={2.4} aria-hidden="true" />{/if}
	{/snippet}
</CheckboxPrimitive.Root>
