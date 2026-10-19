<!--
  §12 settings: deleting the account (§4.5), the screen's last group and its
  one red row ([D-214], [D-269]). The confirmation says what goes with it,
  so the row carries no explanation of its own. Confirming signs in again
  first, with the passkey where there is one ([D-309]).
-->
<script lang="ts">
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import { t } from '#lib/i18n/index.js';
	import { online } from '#lib/state/online.js';
	import { authMethods, refreshAuthMethods } from '#lib/state/auth-methods.js';
	import { cancelOidcLogin } from '#lib/auth/index.js';
	import {
		deletionImpact,
		deleteAccountForever,
		deleteSignIn,
		type DeleteSignIn,
		type DeletionImpact
	} from '#lib/actions/account.js';
	import { AsyncDialog } from '#lib/state/async-action.svelte.js';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	// A failure renders inside the open confirmation instead of dismissing it.
	const confirm = new AsyncDialog<{ impact: DeletionImpact; signIn: DeleteSignIn }>({
		onClose: 'forget'
	});

	// The impact is read before the sheet opens, so its body does not pop in,
	// and the sign-in too, so the tap can open the OIDC popup at once.
	async function openDelete(): Promise<void> {
		const [impact, signIn] = await Promise.all([
			deletionImpact(),
			refreshAuthMethods().then(() => deleteSignIn($authMethods))
		]);
		confirm.open({ impact, signIn });
	}

	// Sentences that read right at zero and one ([D-214]).
	function consequences({ shared, solo }: DeletionImpact): string {
		if (shared === 0 && solo === 0) return t('settings_delete_account_no_lists');
		return [
			shared > 0 ? t('settings_delete_account_shared', { count: shared }) : '',
			solo > 0 ? t('settings_delete_account_solo', { count: solo }) : ''
		]
			.filter(Boolean)
			.join(' ');
	}

	async function confirmDelete(signIn: DeleteSignIn): Promise<void> {
		// The app shell swaps to AuthScreen on its own once signed out.
		await confirm.run(() => deleteAccountForever(signIn));
	}

	// The page cannot see the OIDC popup close ([D-155]), so Cancel stays
	// live while it is open and gives up on it.
	function cancelDelete(): void {
		cancelOidcLogin();
		confirm.close();
	}
</script>

<SettingsGroup>
	<SettingsRow
		label={t('settings_delete_account')}
		tone="danger"
		opens
		disabled={!$online}
		onclick={() => void openDelete()}
	/>
	{#snippet footnote()}
		{#if !$online}<OfflineHint message={t('settings_online_only')} />{/if}
	{/snippet}
</SettingsGroup>

{#if confirm.current}
	{@const { impact, signIn } = confirm.current}
	<ConfirmDialog
		open
		title={t('settings_delete_account')}
		body={consequences(impact)}
		confirmLabel={t('settings_delete_account_confirm')}
		danger="strong"
		busy={confirm.busy}
		cancelWhileBusy
		error={confirm.error}
		onconfirm={() => void confirmDelete(signIn)}
		oncancel={cancelDelete}
	/>
{/if}
