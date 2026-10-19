<!--
  §9.3: the home's own sheets, create and join; a card's are ListDialogs'
  ([D-270]). Which one is open, and what it submits, is HomeActions' state
  (home-actions.svelte.ts); this only renders it.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import PromptDialog from '#lib/components/ui/PromptDialog.svelte';
	import type { HomeActions } from './home-actions.svelte';

	let { actions }: { actions: HomeActions } = $props();
	const dialog = $derived(actions.dialog);
</script>

<PromptDialog
	open={dialog.current?.kind === 'create'}
	title={t('home_new_list')}
	label={t('home_new_list_prompt')}
	maxlength={maxBytesFor('lists', 'name')}
	submitLabel={t('home_new_list')}
	busy={dialog.busy}
	error={dialog.error}
	onsubmit={(name) => void actions.submitCreate(name)}
	oncancel={() => dialog.close()}
/>

<PromptDialog
	open={dialog.current?.kind === 'join'}
	title={t('home_join_list')}
	label={t('home_join_prompt')}
	submitLabel={t('home_join_list')}
	busy={dialog.busy}
	error={dialog.error}
	onsubmit={actions.submitJoin}
	oncancel={() => dialog.close()}
/>
