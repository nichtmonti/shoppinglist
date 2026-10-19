<!--
  The in-list ⋮ sheet (§7.1, §9.1): what the list offers ([D-270]), leaving
  last, as ruled rows like settings' ([D-269]), under the list's own name. App
  settings is the home's ⚙ alone, and the shop-grid density is the sort
  menu's ([D-271]).
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import { online } from '#lib/state/online.js';
	import {
		LEAVE_ACTION as leave,
		LIST_ACTIONS,
		getListActions,
		type ListActionId
	} from './list-actions.svelte';

	let {
		listId,
		name,
		open,
		onclose
	}: { listId: string; name: string; open: boolean; onclose: () => void } = $props();

	// The route's, whose dialogs its layout renders.
	const actions = getListActions();

	// The sheet closes first; rename, leave and the rest keep their own sheet
	// open until the write succeeds, so a failure shows where the user is
	// looking.
	function choose(id: ListActionId): void {
		onclose();
		actions.run(id, listId, name);
	}

	const listActions = LIST_ACTIONS.filter((a) => a !== leave);
</script>

<Sheet {open} title={name || t('list_settings')} {onclose}>
	<!-- The note under the rows it greys, 8px below ([D-327]). -->
	<div class="flex flex-col gap-2">
		<RuledRows flush>
			{#each listActions as action (action.id)}
				<SettingsRow
					label={t(action.label)}
					flush
					opens={action.opens}
					disabled={!actions.available(action.id)}
					onclick={() => choose(action.id)}
				>
					{#snippet icon()}<action.icon aria-hidden="true" />{/snippet}
				</SettingsRow>
			{/each}
			<SettingsRow
				label={t(leave.label)}
				tone="danger"
				flush
				opens
				disabled={!actions.available(leave.id)}
				onclick={() => choose('leave')}
			>
				{#snippet icon()}<leave.icon aria-hidden="true" />{/snippet}
			</SettingsRow>
		</RuledRows>
		{#if !$online}
			<OfflineHint />
		{/if}
	</div>
</Sheet>
