<!--
  The leave-a-list confirmation, shared by the home card's menu and the list's
  settings sheet. The caller owns the AsyncDialog behind it: it stays open
  across the leave and shows a failure in place. The last member leaving
  deletes the list for everyone (§7.3), so then it says so ([D-293]) and
  its button is the solid red of what nothing brings back ([D-214], [D-311]).
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import { listRoster } from '#lib/state/data.js';
	import { refreshRoster } from '#lib/sync/index.js';

	let {
		open,
		listId,
		name,
		busy,
		error,
		onconfirm,
		oncancel
	}: {
		open: boolean;
		listId: string;
		name: string;
		busy: boolean;
		error: string | undefined;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();

	// The cached roster (§7.4): this account alone reads as last. It is read
	// again on open: one cached since the morning would still count a member
	// who left at noon, and the deletion would come without its warning.
	$effect(() => {
		if (open && listId) void refreshRoster(listId).catch(() => {});
	});
	let rosterStore = $derived(listRoster(listId));
	let rosterLoaded = $derived(rosterStore.loaded);
	let last = $derived($rosterLoaded && $rosterStore.length <= 1);
</script>

<ConfirmDialog
	{open}
	title={t('home_action_leave')}
	body={last ? t('home_leave_confirm_last', { name }) : t('home_leave_confirm', { name })}
	confirmLabel={t('home_action_leave')}
	danger={last ? 'strong' : true}
	{busy}
	{error}
	{onconfirm}
	{oncancel}
/>
