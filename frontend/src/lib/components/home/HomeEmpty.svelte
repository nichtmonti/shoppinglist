<!--
  §9.3: the home of an account with no lists here yet — the loading state until
  the first pull lands ([D-182]), the re-auth prompt when that pull cannot land
  because the session expired ([D-182]), and the cold-start empty state once it
  has. ListsHome renders this only when the memberships are loaded and empty.
-->
<script lang="ts">
	import Waiting from '#lib/components/common/Waiting.svelte';
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/index.js';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import InstallPrompt from '#lib/components/install/InstallPrompt.svelte';
	import ReauthButton from '#lib/components/common/ReauthButton.svelte';

	let {
		pulling,
		isOnline,
		reauthHere,
		homeActions
	}: {
		/** No memberships pull has landed yet ([D-182]). */
		pulling: boolean;
		isOnline: boolean;
		/** The first pull cannot land because the session expired: this
		 *  screen asks for the re-auth itself, in the chip's place ([D-182]). */
		reauthHere: boolean;
		/** Create/join/import, shared with the populated home's footer. */
		homeActions: Snippet;
	} = $props();

	// Past this, the loading state says it is still trying, so a slow or failing
	// first pull (the loop retries every 5s) is not an indistinguishable hang.
	const SLOW_PULL_MS = 8000;
	let slowPull = $state(false);
	$effect(() => {
		if (!pulling) return;
		const timer = setTimeout(() => (slowPull = true), SLOW_PULL_MS);
		return () => {
			clearTimeout(timer);
			slowPull = false;
		};
	});
</script>

<!-- Right after sign-up this is the home there is ([D-231], [D-317]). -->
<InstallPrompt class="mx-4 mt-3" />
{#if reauthHere}
	<EmptyState
		data-testid="home-expired"
		emoji="🔑"
		title={t('home_expired_title')}
		body={t('home_expired_body')}
	>
		{#snippet actions()}
			<ReauthButton />
		{/snippet}
	</EmptyState>
{:else if pulling}
	<!-- No create/join/import before the pull answers ([D-182]). -->
	<Waiting
		role="status"
		data-testid="home-loading"
		title={t('home_loading_title')}
		body={!isOnline ? t('home_loading_offline') : slowPull ? t('home_loading_slow') : undefined}
	/>
{:else}
	<EmptyState
		emoji="🛒"
		title={t('home_empty_title')}
		body={t('home_empty_body')}
		actions={homeActions}
	>
		{#if !isOnline}
			<OfflineHint class="mt-2" message={t('home_online_only')} />
		{/if}
	</EmptyState>
{/if}
