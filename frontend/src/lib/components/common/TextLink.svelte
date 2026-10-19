<!--
  A link out of the app in a line of grey text (a credit, the about footer):
  dotted underline, opened in a new tab, padded so a thumb can hit it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { href, children }: { href: string; children: Snippet } = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- a link out of the app, never a route -->
<a
	class="inline-block py-2.5 underline decoration-dotted underline-offset-2 hover:text-foreground"
	{href}
	target="_blank"
	rel="noopener noreferrer">{@render children()}</a
>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
