<!--
  A focus screen's h1 ([D-323]). Where a visitor may not have reached settings
  yet, the language switch shares its row (§12.2), so it reads as a page
  setting, not a second call to action.
-->
<script lang="ts">
	import LocaleToggle from './LocaleToggle.svelte';

	let { title, locale = false }: { title: string; locale?: boolean } = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
	<h1 class="type-hero">{title}</h1>
	{#if locale}<LocaleToggle testid="auth-locale" />{/if}
</div>
