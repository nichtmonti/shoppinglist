<script lang="ts">
	// Keep preview fixtures and tooling out of production, including orphaned chunks.
	const gallery = import.meta.env.DEV ? import('./LiveGallery.svelte') : null;
</script>

<svelte:head><title>Design-Galerie · dev</title></svelte:head>

{#if gallery}
	{#await gallery then module}<module.default />{/await}
{:else}
	<p class="p-6">Nur im Dev-Build.</p>
{/if}
