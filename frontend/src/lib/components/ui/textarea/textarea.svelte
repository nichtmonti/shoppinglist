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
	const field = fieldState();
</script>

<textarea
	bind:this={ref}
	data-slot="textarea"
	class={cn(fieldClass, className)}
	bind:value
	aria-invalid={field?.invalid || undefined}
	aria-describedby={field?.describedBy}
	{...restProps}></textarea>
