<!--
  "Something went wrong", with reload or back to the lists: the error page's
  ([D-197]) and the app shell's boundary's, as a focus screen ([D-323]).
  `detail` is the error's one-line description, already in the server log: the
  thing to screenshot. `reset` is the boundary's: a boundary stays failed until
  reset, so leaving the screen that threw by a client-side navigation (Back)
  resets it.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import FocusScreen from './FocusScreen.svelte';
	import FocusTitle from './FocusTitle.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { t } from '#lib/i18n/index.js';

	let {
		detail = '',
		notFound = false,
		reset
	}: { detail?: string; notFound?: boolean; reset?: () => void } = $props();

	const failedAt = page.url.pathname;
	$effect(() => {
		if (reset && page.url.pathname !== failedAt) reset();
	});
</script>

<FocusScreen class="error-view" role="alert">
	<FocusTitle title={notFound ? t('error_page_not_found') : t('common_error')} />
	{#if !notFound}
		<Hint size="sm">{t('error_page_body')}</Hint>
		{#if detail}
			<code
				class="block max-w-full wrap-break-word rounded-chip bg-tint px-3 py-2 text-meta"
				data-testid="error-detail">{detail}</code
			>
		{/if}
	{/if}
	<!-- Stacked, as every pair of actions is ([D-311]). -->
	<div class="mt-1 flex flex-col gap-2">
		{#if !notFound}
			<Button onclick={() => location.reload()}>{t('error_page_reload')}</Button>
		{/if}
		<!-- A full navigation, not goto(): the client state that just threw is
		     not reused on the way out. -->
		<Button variant={notFound ? 'default' : 'outline'} onclick={() => location.assign(resolve('/'))}
			>{t('common_to_lists')}</Button
		>
	</div>
</FocusScreen>
