<!--
  §12 settings screen: pure composition of the groups ([D-269]). Each group
  owns its state, actions and confirmations, so a component test compiles
  only its group's slice of the import graph.
-->
<script lang="ts">
	import { goBack } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
	import BackButton from '#lib/components/common/BackButton.svelte';
	import SyncBanner from '#lib/components/banner/SyncBanner.svelte';
	import ScreenTitle from '#lib/components/common/ScreenTitle.svelte';
	import AppBar from '#lib/components/common/AppBar.svelte';
	import InstallGroup from './InstallGroup.svelte';
	import AccountGroup from './AccountGroup.svelte';
	import PasskeysGroup from './PasskeysGroup.svelte';
	import { authMethods } from '#lib/state/auth-methods.js';
	import GeneralGroup from './GeneralGroup.svelte';
	import SignOutGroup from './SignOutGroup.svelte';
	import DeleteAccountGroup from './DeleteAccountGroup.svelte';
	import AboutFooter from './AboutFooter.svelte';
	import { demo } from '#demo';
	import type { PasskeyRow } from '#lib/actions/account.js';

	// The route's preload ([D-205]); `null` when it did not arrive in time.
	let { passkeys }: { passkeys: PasskeyRow[] | null } = $props();
</script>

<AppBar>
	{#snippet back()}<BackButton onclick={() => void goBack(resolve('/'))} />{/snippet}
	<!-- [D-130]: the chip, and its re-auth, in every app bar. -->
	{#snippet chip()}<SyncBanner />{/snippet}
	{#snippet title()}
		<!-- One h1, visible; each group's label is an h2 under it ([D-214]). -->
		<ScreenTitle title={t('settings_title')} />
	{/snippet}
</AppBar>

<div class="flex flex-col pb-4">
	<!-- First, while in a browser tab ([D-231]); not for a demo ([D-234]). -->
	{#if !demo.enabled}<InstallGroup />{/if}
	<AccountGroup />
	<!-- [D-76]: hidden on an instance without passkeys; an unknown answer
	     keeps it, since passkeys are on unless turned off. -->
	{#if $authMethods?.passkeys.enabled ?? true}
		<PasskeysGroup preloaded={passkeys} />
	{/if}
	<GeneralGroup />
	<SignOutGroup />
	<DeleteAccountGroup />
</div>
<AboutFooter />
