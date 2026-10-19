<!--
  A screen's title in the app bar ([D-323]): the screen's one h1, on one line
  (it truncates, [D-272]), with an optional line under it in the meta size: a
  count, the list a sub-screen belongs to, or a mode's hint. Focusable from
  script, for a screen that changes mode under the reader (home's arrange).
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	let {
		title,
		meta,
		ref = $bindable()
	}: { title: string; meta?: string; ref?: HTMLElement } = $props();
</script>

<h1 bind:this={ref} tabindex="-1" class="type-title truncate outline-none">{title}</h1>
{#if meta}
	<Hint class="mt-px truncate">{meta}</Hint>
{/if}
