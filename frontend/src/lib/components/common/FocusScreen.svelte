<!--
  A screen outside the lists ([D-323]): sign-in, an invite, the demo's start
  and the error page. One column at the focus width, its blocks 12px apart;
  its title is a FocusTitle.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.js';

	let {
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { children: Snippet } = $props();
</script>

<div
	class={cn('mx-auto flex w-full max-w-(--focus-max) flex-col gap-3 px-5 py-8', className)}
	{...rest}
>
	{@render children()}
</div>
