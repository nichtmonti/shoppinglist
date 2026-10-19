<!--
  §9.1's two empty states of a list view: "no items at all" (a fresh or
  emptied list) and "every item is done". Each view words and dresses them
  its own way; the design gallery renders the same component.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import EmptyState from './EmptyState.svelte';

	let { view, state }: { view: 'shop' | 'list'; state: 'empty' | 'done' } = $props();
</script>

{#if state === 'empty'}
	<!-- A picture, as the done state has ([D-324]): bare text read as a
	     screen that had not loaded. -->
	<EmptyState
		emoji="🛒"
		title={t('list_empty_title')}
		body={t(view === 'shop' ? 'shop_empty_hint' : 'list_empty_body')}
	/>
{:else if view === 'shop'}
	<EmptyState emoji="🎉" title={t('shop_all_done')} />
{:else}
	<!-- Under the done rows, not a screen of its own: a quiet line. -->
	<EmptyState class="all-done pt-6" body={t('list_all_done')} />
{/if}
