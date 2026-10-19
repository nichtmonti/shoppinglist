<!--
  An inline error: announced as it appears (role="alert"), in the danger
  tone. Under a field it is the meta size ([D-325]); a screen-level message
  on a focus screen, whose copy is 14px, takes `size="sm"`.
-->
<script lang="ts">
	import { cn } from '#lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className,
		size = 'meta',
		children,
		...rest
	}: HTMLAttributes<HTMLParagraphElement> & { size?: 'meta' | 'sm' } = $props();
</script>

<p
	role="alert"
	class={cn(size === 'sm' ? 'text-sm' : 'text-meta', 'text-danger', className)}
	{...rest}
>
	{@render children?.()}
</p>
