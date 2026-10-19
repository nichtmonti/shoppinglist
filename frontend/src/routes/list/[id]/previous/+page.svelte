<script lang="ts">
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.js';
	import PreviousItems from '#lib/components/history/PreviousItems.svelte';

	let listId = $derived(page.params.id ?? '');
</script>

<svelte:head>
	<title>{t('history_previous_items')}</title>
</svelte:head>

<PreviousItems {listId} />
