<!--
  A label, its control, then a hint or an error under it ([D-325]): the
  error replaces the hint, and the control inside is marked invalid and
  described by whichever line shows. The label sits 6px above the control.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { setFieldState } from './context.js';

	let {
		ref = $bindable(null),
		class: className,
		error,
		hint,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** Shown under the control in place of the hint; marks it invalid. */
		error?: string;
		hint?: string;
	} = $props();

	const id = $props.id();
	const state = $state({ invalid: false, describedBy: undefined as string | undefined });
	$effect.pre(() => {
		state.invalid = !!error;
		state.describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
	});
	setFieldState(state);
</script>

<div
	bind:this={ref}
	role="group"
	data-slot="field"
	class={cn('flex w-full flex-col gap-1.5 *:w-full [&>.sr-only]:w-auto', className)}
	{...restProps}
>
	{@render children?.()}
	{#if error}
		<ErrorText id="{id}-error">{error}</ErrorText>
	{:else if hint}
		<Hint id="{id}-hint">{hint}</Hint>
	{/if}
</div>
