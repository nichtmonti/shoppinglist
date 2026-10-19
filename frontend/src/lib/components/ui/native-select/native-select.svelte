<!--
  The platform's own picker, closed in the app's field ([D-314]): a phone
  opens its wheel or list, which no drawn menu beats for a short choice.
-->
<script lang="ts">
	import { fieldState } from '#lib/components/ui/field/context.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import { fieldClass } from '../input/field-class.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLSelectAttributes> = $props();

	// Inside a Field, its error or hint describes this control ([D-325]).
	const field = fieldState();
</script>

<div class={cn('relative w-full', className)}>
	<select
		bind:this={ref}
		data-slot="native-select"
		class={cn(fieldClass, 'cursor-pointer appearance-none pe-10')}
		bind:value
		aria-invalid={field?.invalid || undefined}
		aria-describedby={field?.describedBy}
		{...restProps}
	>
		{@render children?.()}
	</select>
	<ChevronDown
		class="pointer-events-none absolute inset-e-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
		aria-hidden="true"
	/>
</div>
