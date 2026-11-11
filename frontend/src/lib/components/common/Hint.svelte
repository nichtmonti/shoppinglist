<!--
  A grey line that explains ([D-325]): `meta` under a control, in a row or
  under a sheet's block; `sm` as the body copy of a focus screen or a sheet;
  `micro` for a credit, a row's metadata or a settings group's footnote
  ([D-351]).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.js';

	let {
		size = 'meta',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLParagraphElement> & {
		size?: 'micro' | 'meta' | 'sm';
		children: Snippet;
	} = $props();
</script>

<p
	class={cn(
		size === 'sm' ? 'text-sm' : size === 'micro' ? 'text-micro' : 'text-meta',
		'text-muted-foreground',
		className
	)}
	{...rest}
>
	{@render children()}
</p>
