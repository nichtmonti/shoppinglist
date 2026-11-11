<script lang="ts">
	import { fieldState } from '#lib/components/ui/field/context.js';
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { fieldClass } from '../input/field-class.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		...restProps
	}: WithElementRef<HTMLTextareaAttributes> = $props();

	// Inside a Field, its error or hint describes this control ([D-325]).
	// The resize grip is a mouse's tool; under a finger it is a stray mark.
	const field = fieldState();
</script>

<textarea
	bind:this={ref}
	data-slot="textarea"
	class={cn(fieldClass, 'pointer-coarse:resize-none', className)}
	bind:value
	aria-invalid={field?.invalid || undefined}
	aria-describedby={field?.describedBy}
	{...restProps}></textarea>
