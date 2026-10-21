<!--
  §9.3: the app root, "Meine Listen": a user's lists are their membership
  rows, read from the local stores; mutations go through #lib/actions/lists.ts.

  The sort modes, the card list, and the arrange mode that makes the custom
  order ([D-90]): cards never drag; arranging is a task you enter and leave.
  The actions are HomeActions, whose sheets HomeDialogs renders.
-->
<script lang="ts">
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import { tick } from 'svelte';
	import { closeMode, modeOpen, openMode } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
	import { reconcileOrder, sortLists } from '#lib/list-order.js';
	import { memberships, listIndex, membershipsSyncedAt } from '#lib/state/data.js';
	import { listSort, listOrder } from '#lib/state/prefs.js';
	import { online } from '#lib/state/online.js';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import ListCard from './ListCard.svelte';
	import ArrangeList from '#lib/components/common/ArrangeList.svelte';
	import ArrangeDone from '#lib/components/common/ArrangeDone.svelte';
	import ListSummary from '#lib/components/list/ListSummary.svelte';
	import ListSort from './ListSort.svelte';
	import HomeEmpty from './HomeEmpty.svelte';
	import InstallPrompt from '#lib/components/install/InstallPrompt.svelte';
	import HomeDialogs from './HomeDialogs.svelte';
	import { HomeActions } from './home-actions.svelte';
	import { ListActions } from '#lib/components/list/list-actions.svelte.js';
	import ListDialogs from '#lib/components/list/ListDialogs.svelte';
	import SyncBanner from '#lib/components/banner/SyncBanner.svelte';
	import AppBar from '#lib/components/common/AppBar.svelte';
	import ScreenTitle from '#lib/components/common/ScreenTitle.svelte';
	import { authState } from '#lib/auth/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import Settings from '@lucide/svelte/icons/settings';
	import { cubicOut } from 'svelte/easing';
	import { dur, DND_FLIP_MS, flipNear } from '#lib/state/motion.js';

	const membershipsLoaded = memberships.loaded;
	const syncedAtLoaded = membershipsSyncedAt.loaded;
	// [D-182]: until the first pull lands, zero rows mean "not here yet", and
	// offering create/join would let users create lists they already have.
	let pulling = $derived($membershipsSyncedAt === null);
	let rows = $derived($memberships);
	let index = $derived($listIndex);
	let mode = $derived($listSort);
	let order = $derived($listOrder);

	// §9.3 ordering (#lib/list-order).
	let sorted = $derived(sortLists(rows, mode, order, index));

	// [D-90] Arranging starts from the order on screen, not a custom order
	// saved long ago. The mode is a history entry, so back closes it. One list
	// has nothing to arrange, so it ends below two (a leave elsewhere).
	let arrangeOpen = $derived(modeOpen('arrange-lists') && rows.length > 1);
	let heading = $state<HTMLElement>();
	let sortTrigger = $state<HTMLElement | null>(null);

	async function startArranging(): Promise<void> {
		if (mode !== 'custom') {
			await listOrder.set(sorted.map((m) => m.list));
			await listSort.set('custom');
		}
		openMode('arrange-lists');
	}

	// Focus follows the mode however it changed: in, to the title (the menu
	// that opened it is gone, so its focus return has nowhere to land); out, to
	// the sort trigger.
	let wasOpen = false;
	$effect(() => {
		const open = arrangeOpen;
		if (open === wasOpen) return;
		wasOpen = open;
		void tick().then(() => requestAnimationFrame(() => (open ? heading : sortTrigger)?.focus()));
	});

	// Keep the custom order aware of every membership: a new list slots to the
	// top (§9.3), a vanished one (§7.3) drops out. Only once both have loaded:
	// either store's initial `[]` would overwrite the saved order.
	const listOrderLoaded = listOrder.loaded;
	$effect(() => {
		if (!$membershipsLoaded || !$listOrderLoaded) return;
		const reconciled = reconcileOrder(
			order,
			rows.map((m) => m.list)
		);
		if (reconciled) void listOrder.set(reconciled);
	});

	// The first pull cannot land while the session is expired (every sync route
	// answers 401): the empty home asks for the re-auth itself, in the chip's
	// place ([D-182]). Offline wins, as it does for the chip.
	let auth = $derived($authState);
	let reauthHere = $derived(
		rows.length === 0 && pulling && auth.nickname !== null && !auth.isValid && $online
	);

	const actions = new HomeActions(() => $online);
	const listActions = new ListActions(() => $online);
</script>

<!-- Create/join/import, rendered in the empty state and the footer. The
     offline hint stays out: its parent and spacing differ by call site. -->
{#snippet homeActions()}
	<Button type="button" disabled={!$online} onclick={actions.create}>
		{t('home_new_list')}
	</Button>
	<Button variant="outline" type="button" disabled={!$online} onclick={actions.join}>
		{t('home_join_list')}
	</Button>
	<Button variant="outline" type="button" onclick={actions.openImport}>
		{t('home_import_list')}
	</Button>
{/snippet}

{#snippet settingsLink()}
	<a
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		href={resolve('/settings')}
		aria-label={t('common_settings')}><Settings class="bar-icon size-5.5" /></a
	>
{/snippet}

<!-- The stores seed with `[]`: without the loaded checks the empty state
     would flash for a frame on every mount. -->
{#if !$membershipsLoaded || !$syncedAtLoaded}
	<EmptyState aria-busy="true" />
{:else}
	<!-- One bar with or without lists, so creating the first moves nothing
	     ([D-272], [D-323]). -->
	<AppBar>
		{#snippet chip()}
			{#if reauthHere}
				<!-- The prompt below IS the chip's action; the empty slot keeps the gear put. -->
				<span class="size-6.5" aria-hidden="true"></span>
			{:else}
				<!-- Its count is the whole device's outbox here ([D-130]). -->
				<SyncBanner />
			{/if}
		{/snippet}
		{#snippet title()}
			<ScreenTitle
				bind:ref={heading}
				title={arrangeOpen ? t('home_arrange_title') : t('home_title')}
				meta={arrangeOpen
					? t('arrange_hint')
					: pulling && rows.length === 0
						? undefined
						: t('home_list_count', { count: rows.length })}
			/>
		{/snippet}
		{#snippet actions()}
			<!-- The list app bar's order: sort, then the last slot. Arranging has
			     one way out, "Fertig", so neither shows. -->
			{#if !arrangeOpen}
				{#if rows.length > 0}
					<ListSort
						bind:trigger={sortTrigger}
						onarrange={rows.length > 1 ? () => void startArranging() : undefined}
					/>
				{/if}
				{@render settingsLink()}
			{/if}
		{/snippet}
	</AppBar>

	{#if rows.length === 0}
		<HomeEmpty {pulling} isOnline={$online} {reauthHere} {homeActions} />
	{:else if arrangeOpen}
		<div class="px-4 py-3">
			<ArrangeList
				cards
				rows={sorted}
				idOf={(m) => m.list}
				labelOf={(m) => m.name}
				onreorder={(ids) => void listOrder.set(ids)}
				label={t('home_title')}
			>
				<!-- What the card shows, so the lists still look like the lists ([D-238]). -->
				{#snippet row(m)}
					<span class="flex min-w-0 flex-col gap-1.5"
						><ListSummary membership={m} nameLines={2} /></span
					>
				{/snippet}
			</ArrangeList>
		</div>
		<!-- It takes the create/join/import footer's place. -->
		<ArrangeDone ondone={() => closeMode('arrange-lists')} />
	{:else}
		<div class="flex flex-col gap-(--card-gap) px-4 py-3">
			<!-- Installing comes after sign-up ([D-231]), above the lists ([D-317]). -->
			<InstallPrompt />
			{#each sorted as membership (membership.list)}
				<!-- A component cannot carry `animate:`, so the wrapper is what flips
				     when the order changes (a sort switch, a finished arrange). -->
				<div class="block" animate:flipNear={{ duration: dur(DND_FLIP_MS), easing: cubicOut }}>
					<ListCard
						{membership}
						offline={!$online}
						onaction={(id) => listActions.run(id, membership.list, membership.name)}
					/>
				</div>
			{/each}
		</div>

		<div class="flex flex-col gap-2 px-4 pb-5 pt-1">
			{@render homeActions()}
			{#if !$online}
				<OfflineHint class="mt-2" message={t('home_online_only')} />
			{/if}
		</div>
	{/if}
{/if}

<HomeDialogs {actions} />
<ListDialogs actions={listActions} />
