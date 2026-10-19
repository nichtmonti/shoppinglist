<!--
  The sheets a list's ⋮ actions open ([D-270]): share, rename, duplicate,
  leave and clear history, for the home card's menu, the in-list sheet and
  Frühere Artikel ([D-271]) alike. Which one is open, and what it submits, is
  ListActions' state (list-actions.svelte.ts); this only renders it.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import PromptDialog from '#lib/components/ui/PromptDialog.svelte';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import ShareSheet from '#lib/components/share/ShareSheet.svelte';
	import LeaveListDialog from './LeaveListDialog.svelte';
	import type { ListActions } from './list-actions.svelte';

	let { actions }: { actions: ListActions } = $props();
	const dialog = $derived(actions.dialog);
</script>

<ShareSheet
	open={actions.shareFor !== null}
	listId={actions.sharedLast}
	onclose={() => (actions.shareFor = null)}
/>

{#if dialog.current?.kind === 'rename'}
	{@const d = dialog.current}
	<!-- [D-08]: one name, every member's. -->
	<PromptDialog
		open
		title={t('home_action_rename')}
		description={t('home_rename_prompt')}
		label={t('common_name')}
		maxlength={maxBytesFor('lists', 'name')}
		value={d.current}
		busy={dialog.busy}
		error={dialog.error}
		onsubmit={(name) => void actions.submitRename(d.listId, name)}
		oncancel={() => dialog.close()}
	/>
{/if}

{#if dialog.current?.kind === 'clone'}
	{@const d = dialog.current}
	<PromptDialog
		open
		title={t('home_clone_title')}
		label={t('home_clone_prompt')}
		maxlength={maxBytesFor('lists', 'name')}
		value={t('home_clone_default_name', { name: d.name })}
		submitLabel={t('home_action_duplicate')}
		busy={dialog.busy}
		error={dialog.error}
		onsubmit={(name) => void actions.submitClone(d.listId, name)}
		oncancel={() => dialog.close()}
	/>
{/if}

{#if dialog.current?.kind === 'leave'}
	{@const d = dialog.current}
	<LeaveListDialog
		open
		listId={d.listId}
		name={d.name}
		busy={dialog.busy}
		error={dialog.error}
		onconfirm={() => void actions.submitLeave(d.listId)}
		oncancel={() => dialog.close()}
	/>
{/if}

{#if dialog.current?.kind === 'clear-history'}
	{@const d = dialog.current}
	<!-- Soft red: it forgets when things were bought, never an item on the
	     list; the solid fill is the account deletion's alone ([D-214],
	     [D-332]). -->
	<ConfirmDialog
		open
		title={t('home_clear_confirm_title')}
		body={t('home_clear_confirm', { name: d.name })}
		confirmLabel={t('home_clear_confirm_action')}
		danger
		busy={dialog.busy}
		error={dialog.error}
		onconfirm={() => void actions.submitClearHistory(d.listId)}
		oncancel={() => dialog.close()}
	/>
{/if}
