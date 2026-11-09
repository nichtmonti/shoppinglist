<!--
  §12 settings: the sign-out group ([D-269]). This device's own sign-out
  ([D-55]) is local-only, works offline and revokes nothing, so it takes no
  confirmation, unless edits are still queued: the sign-out wipes the outbox
  with the rest of the account's data (§5.6), and they would be lost unsent.
  Logging out everywhere (§5.6) is confirmed and stays neutral ([D-214]),
  unless the same queued edits would go with it ([D-293]).
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { logout } from '#lib/auth/index.js';
	import { logoutEverywhere } from '#lib/actions/account.js';
	import { AsyncDialog } from '#lib/state/async-action.svelte.js';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import { outbox } from '#lib/state/data.js';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import { demo } from '#demo';

	// [D-234] A demo account's sign-out deletes it; null in every other build.
	const DemoSignOut = demo.SignOut;

	const queued = outbox('');
	let confirmingDevice = $state(false);
	const everywhere = new AsyncDialog<true>({ onClose: 'forget' });

	function signOut(): void {
		if ($queued.length > 0) confirmingDevice = true;
		else void logout();
	}

	// A success signs this device out too. A failure leaves the user signed in
	// and says so in the dialog: claiming "logged out everywhere" when the
	// rotation did not happen is the outcome to avoid.
	async function confirmLogoutEverywhere(): Promise<void> {
		await everywhere.run(() => logoutEverywhere());
	}
</script>

<SettingsGroup title={t('settings_section_signout')} icon="👋" color="violet">
	{#if DemoSignOut}
		<!-- A demo account has no login to come back with ([D-234]): signing
		     out everywhere would only strand it until the sweep. -->
		<DemoSignOut />
	{:else}
		<SettingsRow label={t('settings_signout_device')} opens={false} onclick={signOut} />
		<SettingsRow
			label={t('settings_logout_everywhere')}
			opens
			onclick={() => everywhere.open(true)}
		/>
	{/if}
</SettingsGroup>

<ConfirmDialog
	open={confirmingDevice}
	title={t('settings_signout_device')}
	body={t('settings_signout_device_unsynced')}
	confirmLabel={t('settings_signout_device_anyway')}
	danger
	onconfirm={() => void logout()}
	oncancel={() => (confirmingDevice = false)}
/>

<ConfirmDialog
	open={everywhere.current !== null}
	title={t('settings_logout_everywhere')}
	body={$queued.length > 0
		? t('settings_logout_everywhere_confirm_unsynced')
		: t('settings_logout_everywhere_confirm')}
	confirmLabel={t('settings_logout_everywhere_confirm_action')}
	danger={$queued.length > 0}
	busy={everywhere.busy}
	error={everywhere.error}
	onconfirm={() => void confirmLogoutEverywhere()}
	oncancel={() => everywhere.close()}
/>
