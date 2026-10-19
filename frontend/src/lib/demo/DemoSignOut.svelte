<!--
  Settings' sign-out row on a demo instance ([D-234]). A demo account has no
  way back in, so signing out deletes it, as "Konto löschen" does.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { deleteAccountForever } from '#lib/actions/account.js';
	import { AsyncDialog } from '#lib/state/async-action.svelte.js';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';

	const confirm = new AsyncDialog<true>({ onClose: 'forget' });
</script>

<SettingsRow
	label={t('demo_signout')}
	hint={t('demo_signout_hint')}
	opens
	onclick={() => confirm.open(true)}
/>

{#if confirm.current}
	<ConfirmDialog
		open
		title={t('demo_signout')}
		body={t('demo_signout_confirm')}
		confirmLabel={t('demo_signout_confirm_action')}
		danger="strong"
		busy={confirm.busy}
		error={confirm.error}
		onconfirm={() => void confirm.run(() => deleteAccountForever())}
		oncancel={() => confirm.close()}
	/>
{/if}
