<script lang="ts">
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.js';
	import CategoryEditor from '#lib/components/categories/CategoryEditor.svelte';

	let listId = $derived(page.params.id ?? '');
</script>

<svelte:head>
	<title>{t('categories_title')}</title>
</svelte:head>

<CategoryEditor {listId} />
