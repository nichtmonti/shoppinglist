<!-- [D-254] Items from a text list onto this list: a sub-screen of the list, like
     its categories and previous items, reached by pasting a list into its add
     field ([D-271]), which hands the text over in memory. -->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.js';
	import { clearImportHandoff, importHandoff } from '#lib/import-handoff.js';
	import TextImportScreen from '#lib/components/import/TextImportScreen.svelte';

	let listId = $derived(page.params.id ?? '');
	// Read once, and kept for a reload until the screen is left, as the shared
	// text on /import is.
	const sharedText = importHandoff();
	onDestroy(clearImportHandoff);
</script>

<svelte:head>
	<title>{t('import_add_title')}</title>
</svelte:head>

{#key listId}
	<TextImportScreen {listId} {sharedText} />
{/key}
