<!--
  §12 settings: the account group ([D-269]), the nickname (renamed in a
  prompt) with the §5.9 OIDC link, or the OIDC login it is connected as and
  its removal ([D-76]). Sign-out is SignOutGroup's ([D-214]).
-->
<script lang="ts">
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n/index.js';
	import { authState, cancelOidcLogin, linkOidc, unlinkOidc } from '#lib/auth/index.js';
	import { oidcProvider } from '#lib/auth/login-methods.js';
	import { memberName } from '#lib/member-name.js';
	import { authMethods, refreshAuthMethods } from '#lib/state/auth-methods.js';
	import { online } from '#lib/state/online.js';
	import { updateNickname } from '#lib/actions/account.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import { AsyncAction, AsyncDialog } from '#lib/state/async-action.svelte.js';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import PromptDialog from '#lib/components/ui/PromptDialog.svelte';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	// The value the editor starts from; an empty nickname (an OIDC provider
	// that sent no name) shows the placeholder but edits from "".
	let nickname = $derived($authState.nickname ?? '');
	const nicknamePrompt = new AsyncDialog<true>({ onClose: 'finish' });

	// §5.9 [D-76]: the OIDC link, offered when the instance has OIDC on
	// ([D-76]) and the server says this account lacks it ([D-25]). A linked
	// account sees which identity, and can remove it ([D-76]).
	let oidc = $derived($authMethods?.oidc);
	// What this card did itself, until the next refresh reports it; each
	// replaces the other, so a link after a removal shows as linked.
	let changedHere = $state<'linked' | 'unlinked' | null>(null);
	let linked = $derived(
		changedHere === 'linked' || (changedHere !== 'unlinked' && oidc?.linked === true)
	);
	// The server's identity; after a change here, the next refresh brings it.
	let identity = $derived(changedHere === null ? oidc?.identity : undefined);
	const linkAction = new AsyncAction();
	let canLinkOidc = $derived(!!$authMethods && !!oidcProvider($authMethods) && !linked);
	let showsLinked = $derived(oidc?.enabled === true && linked);
	// Removal needs a passkey to fall back on: with passkeys off the server
	// would refuse, so it is not offered. Whether the account has one is the
	// server's to say, in its refusal.
	let canUnlink = $derived(showsLinked && $authMethods?.passkeys.enabled === true);
	const unlinkDialog = new AsyncDialog<{ name: string }>({ onClose: 'forget' });

	onMount(() => {
		void refreshAuthMethods();
	});

	async function linkOidcAccount(): Promise<void> {
		const provider = oidc?.provider;
		if (!provider) return;
		const attempt = await linkAction.run(() => linkOidc(provider));
		if (attempt.ok && attempt.value) {
			changedHere = 'linked';
			void settleAfterRefresh();
		}
	}

	// Only a fresh server answer replaces this card's note: offline, the last
	// answer predates the change.
	async function settleAfterRefresh(): Promise<void> {
		if (await refreshAuthMethods()) changedHere = null;
	}

	async function confirmUnlink(): Promise<void> {
		if ((await unlinkDialog.run(() => unlinkOidc())).ok) {
			changedHere = 'unlinked';
			void settleAfterRefresh();
		}
	}
</script>

<SettingsGroup title={t('settings_section_account')} icon="👤" color="blue">
	<SettingsRow
		label={t('settings_nickname')}
		hint={t('settings_nickname_hint')}
		value={memberName(nickname)}
		valueTestid="settings-nickname"
		disabled={!$online}
		opens
		onclick={() => nicknamePrompt.open(true)}
	/>
	<!-- §5.9 [D-76]: online-only, and in the account group because it adds a
	     login to this account and destroys nothing. -->
	{#if showsLinked}
		<SettingsRow
			label={identity
				? t('settings_oidc_linked_as', { name: oidc?.name ?? '', identity })
				: t('settings_oidc_linked', { name: oidc?.name ?? '' })}
		/>
		{#if canUnlink}
			<SettingsRow
				label={t('settings_unlink_oidc')}
				tone="danger"
				disabled={!$online}
				opens
				onclick={() => unlinkDialog.open({ name: oidc?.name ?? '' })}
			/>
		{/if}
	{/if}
	{#if canLinkOidc}
		<!-- While the provider's popup is open the row cancels it (OidcButton's
		     reason: the page cannot tell whether the popup is still there). -->
		{#if linkAction.busy}
			<SettingsRow label={t('common_cancel')} opens={false} onclick={cancelOidcLogin} />
		{:else}
			<SettingsRow
				label={t('settings_link_oidc', { name: oidc?.name ?? '' })}
				hint={t('settings_link_oidc_hint', { name: oidc?.name ?? '' })}
				disabled={!$online}
				opens
				onclick={() => void linkOidcAccount()}
			/>
		{/if}
	{/if}
	{#snippet footnote()}
		{#if !$online}<OfflineHint message={t('settings_online_only')} />{/if}
		{#if linkAction.error}<ErrorText>{linkAction.error}</ErrorText>{/if}
	{/snippet}
</SettingsGroup>

<PromptDialog
	open={nicknamePrompt.current !== null}
	title={t('settings_nickname_title')}
	label={t('settings_nickname')}
	description={t('settings_nickname_hint')}
	value={nickname}
	maxlength={maxBytesFor('accounts', 'nickname')}
	busy={nicknamePrompt.busy}
	error={nicknamePrompt.error}
	onsubmit={(next) => void nicknamePrompt.run(() => updateNickname(next))}
	oncancel={() => nicknamePrompt.close()}
/>

{#if unlinkDialog.last}
	{@const c = unlinkDialog.last}
	<ConfirmDialog
		open={unlinkDialog.current !== null}
		title={t('settings_unlink_oidc_title', { name: c.name })}
		body={t('settings_unlink_oidc_confirm', { name: c.name })}
		confirmLabel={t('settings_unlink_oidc_confirm_action')}
		danger
		busy={unlinkDialog.busy}
		error={unlinkDialog.error}
		onconfirm={() => void confirmUnlink()}
		oncancel={() => unlinkDialog.close()}
	/>
{/if}
