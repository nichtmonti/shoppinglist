<!--
  A small indeterminate spinner in the current text colour, centred. The
  caller's `class` adds spacing.
-->
<script lang="ts">
	import { cn } from '#lib/utils.js';

	let { class: className }: { class?: string } = $props();
</script>

<span
	class={cn(
		'mx-auto block size-6 rounded-full border-2 border-current border-t-transparent animate-spin',
		className
	)}
	aria-hidden="true"
></span>
