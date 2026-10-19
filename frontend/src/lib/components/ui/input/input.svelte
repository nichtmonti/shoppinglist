<script lang="ts">
	import { fieldState } from '#lib/components/ui/field/context.js';
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { fieldClass } from './field-class.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		'data-slot': dataSlot = 'input',
		...restProps
	}: WithElementRef<HTMLInputAttributes> = $props();

	// Inside a Field, its error or hint describes this control ([D-325]).
	const field = fieldState();
</script>

<input
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(fieldClass, className)}
	bind:value
	aria-invalid={field?.invalid || undefined}
	aria-describedby={field?.describedBy}
	{...restProps}
/>
