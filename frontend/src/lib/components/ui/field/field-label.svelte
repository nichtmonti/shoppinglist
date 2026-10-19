<script lang="ts">
	import { Label } from '#lib/components/ui/label/index.js';
	import { cn } from '#lib/utils.js';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: ComponentProps<typeof Label> = $props();
</script>

<!-- A field's label is a caption ([D-314]); the Field spaces it ([D-325]). -->
<Label bind:ref data-slot="field-label" class={cn('type-caption', className)} {...restProps}>
	{@render children?.()}
</Label>
