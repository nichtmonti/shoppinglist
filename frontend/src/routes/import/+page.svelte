<!--
  [D-254] /import: a list as text, or a backup file. Reached from the home's
  „Liste importieren“, and as the web app manifest's share target
  (`?text=…&title=…`), which is how another app's "Teilen" lands here.
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceOwnUrl } from '#lib/history-layers.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { tabValue } from '#lib/safe-storage.js';
	import TextImportScreen from '#lib/components/import/TextImportScreen.svelte';

	// Read once: the screen keeps the text, the URL does not need to. The tab
	// keeps the share until the screen is left, so a reload, as Safari does to
	// a tab in the background, still has it ([D-292]).
	const kept = tabValue('import-share');
	const params = page.url.searchParams;
	const fromUrl = params.has('text') || params.has('title');
	if (fromUrl) {
		kept.set(JSON.stringify({ text: params.get('text') ?? '', title: params.get('title') ?? '' }));
	}
	const share: { text: string; title: string } = fromUrl
		? { text: params.get('text') ?? '', title: params.get('title') ?? '' }
		: JSON.parse(kept.get() ?? '{"text":"","title":""}');
	// Some apps send the whole list as the share's subject and no body; then
	// the subject is the text, not a name for it.
	const bodyless = !share.text && share.title.includes('\n');
	const sharedText = bodyless ? share.title : share.text;
	const sharedTitle = bodyless ? '' : share.title;

	onDestroy(() => kept.clear());

	onMount(() => {
		// The shared list is not something the address bar, a reload or the
		// history should carry around.
		if (fromUrl) {
			const url = new URL(page.url.href);
			url.searchParams.delete('text');
			url.searchParams.delete('title');
			void replaceOwnUrl(url, page.state);
		}
	});
</script>

<svelte:head>
	<title>{t('home_import_list')}</title>
</svelte:head>

<TextImportScreen {sharedText} {sharedTitle} />
