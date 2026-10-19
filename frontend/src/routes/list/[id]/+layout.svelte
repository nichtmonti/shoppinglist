<!--
  The in-list shell (§9.1, §9.3): title with the quick-switcher, member line,
  view switch, sync chip, and the active list's SSE subscription, which §8.5
  scopes to the list on screen (`setActiveList` orders it across fast
  navigation). A list can vanish underneath this route (§7.3, §8.6 `gone`), so
  "no membership" renders a notice rather than throwing.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goUp } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
	import { listMembership, listRoster, memberships, membershipsSyncedAt } from '#lib/state/data.js';
	import { listView } from '#lib/state/prefs.js';
	import { setActiveList } from '#lib/sync/index.js';
	import BackButton from '#lib/components/common/BackButton.svelte';
	import { subScreen } from '#lib/components/common/sub-screen.svelte.js';
	import ScreenTitle from '#lib/components/common/ScreenTitle.svelte';
	import AppBar from '#lib/components/common/AppBar.svelte';
	import SyncBanner from '#lib/components/banner/SyncBanner.svelte';
	import SyncLine from '#lib/components/banner/SyncLine.svelte';
	import ListSwitcher from '#lib/components/list/ListSwitcher.svelte';
	import ItemSort from '#lib/components/list/ItemSort.svelte';
	import ListSettingsSheet from '#lib/components/list/ListSettingsSheet.svelte';
	import ListDialogs from '#lib/components/list/ListDialogs.svelte';
	import { ListActions, setListActions } from '#lib/components/list/list-actions.svelte.js';
	import { online } from '#lib/state/online.js';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import { Segmented } from '#lib/components/ui/segmented/index.js';

	let { children } = $props();

	let listId = $derived(page.params.id ?? '');
	let membershipStore = $derived(listMembership(listId));
	let rosterStore = $derived(listRoster(listId));
	let membership = $derived($membershipStore);
	let roster = $derived($rosterStore);
	let known = $derived($memberships.some((m) => m.list === listId));
	// "Not found" only once the mirror has answered AND holds a pulled
	// membership set ([D-182]); before that, after a fresh sign-in or for the
	// first frame, the list is merely unread ([D-185]).
	const membershipsLoaded = memberships.loaded;
	let listsPulled = $derived($membershipsLoaded && $membershipsSyncedAt !== null);
	let onPreviousItems = $derived(page.route?.id === '/list/[id]/previous');
	// A sub-route (previous items, categories, adding from text) titles the bar
	// with its own name, the list's under it ([D-323]).
	let onListPage = $derived(page.route?.id === '/list/[id]');
	// Nothing view-dependent renders before the pref has answered ([D-196]).
	const viewLoaded = listView.loaded;
	let viewValue = $derived<'shop' | 'list' | ''>($viewLoaded ? $listView : '');
	let settingsOpen = $state(false);
	// One ListActions for the route and its sub-screens, with one set of
	// dialogs ([D-270]). Leaving takes the list away, so the way out is home.
	const listActions = setListActions(
		new ListActions(
			() => $online,
			() => goUp(resolve('/'))
		)
	);

	// One ‹ ([D-304]): on the list it goes home, on a sub-screen back to the
	// list, or to the sub-screen's own step.
	function goBackOne(): void {
		if (onListPage) void goUp(resolve('/'));
		else if (subScreen.step) subScreen.step();
		else void goUp(resolve('/list/[id]', { id: listId }));
	}

	// Roster refresh is deliberately not wired here: §7.4 pins its three triggers.
	$effect(() => {
		void setActiveList(listId);
	});

	onDestroy(() => void setActiveList(null));

	// The switch flips the device preference (§9.1).
	function selectView(view: 'shop' | 'list' | '') {
		if (!view) return; // Segmented already swallows the deselect; belt and braces
		void listView.set(view);
	}
</script>

<svelte:head>
	<title>{membership?.name ?? t('common_app_name')}</title>
</svelte:head>

{#if onListPage}
	<!-- Visually-hidden h1: the visible title is the switcher's trigger button, which is not a heading. -->
	<h1 class="sr-only">{membership?.name ?? t('common_app_name')}</h1>
{/if}
<AppBar>
	{#snippet back()}<BackButton onclick={goBackOne} />{/snippet}
	{#snippet chip()}
		<!-- A fixed-size chip, so nothing moves when the sync state settles. -->
		{#if known}<SyncBanner {listId} />{/if}
	{/snippet}
	{#snippet title()}
		{#if !onListPage}
			<ScreenTitle title={subScreen.title ?? ''} meta={subScreen.meta ?? membership?.name} />
		{:else}
			<ListSwitcher currentListId={listId} listName={membership?.name ?? ''} />
			<!-- Kept as a line while unread, so the bar does not change height. The
		     sync's state takes its place when there is something to say, and a
		     tap opens the members, as ⋮ → „Teilen & Mitglieder“ does ([D-296]). -->
			{#if known}
				<SyncLine
					{listId}
					members={roster.length > 1
						? t('list_members_shared', { count: roster.length })
						: t('list_members_solo')}
					onmembers={() => listActions.run('share', listId, membership?.name ?? '')}
				/>
			{:else}
				<div class="mt-px truncate text-meta text-muted-foreground">&nbsp;</div>
			{/if}
		{/if}
	{/snippet}
	{#snippet actions()}
		<!-- A sub-screen keeps only what acts on it: previous items sort. -->
		{#if known && (onListPage || onPreviousItems)}<ItemSort
				history={onPreviousItems}
				density={onListPage && $viewLoaded && $listView === 'shop'}
			/>{/if}
		<!-- Not for a list that is not this account's ([D-293]): its actions
		     would act on nothing. -->
		{#if onListPage && (known || !listsPulled)}
			<Button
				variant="ghost"
				size="icon"
				type="button"
				onclick={() => (settingsOpen = true)}
				aria-label={membership?.name
					? t('common_actions_for', { name: membership.name })
					: t('list_settings')}
				data-testid="list-menu"
			>
				<EllipsisVertical class="bar-icon size-5" />
			</Button>
		{/if}
	{/snippet}
	{#snippet below()}
		<!-- §9.1's shop/edit switch, as tabs on the bar's foot, so it reads as
		     choosing the view rather than as part of the list ([D-276]). -->
		{#if !onListPage}
			<!-- A sub-screen has no view to choose ([D-323]). -->
		{:else if known}
			<Segmented
				variant="tabs"
				value={viewValue}
				options={[
					{ value: 'shop', label: t('list_view_shop'), icon: ShoppingCart },
					{ value: 'list', label: t('list_view_list'), icon: ListChecks }
				]}
				onchange={selectView}
				label={t('list_view_shop') + ' / ' + t('list_view_list')}
				testid="view-toggle"
			/>
		{:else if !listsPulled}
			<!-- Its place while the list loads, so the bar does not grow under
			     the reader ([D-276]); a list that is not there gets no switch. -->
			<div class="h-11 border-t border-border" aria-hidden="true"></div>
		{/if}
	{/snippet}
</AppBar>

{#if known}
	{@render children()}
{:else if listsPulled}
	<EmptyState emoji="🔍" title={t('list_not_found_title')} body={t('list_not_found')}>
		{#snippet actions()}
			<Button onclick={() => void goUp(resolve('/'))}>{t('common_to_lists')}</Button>
		{/snippet}
	</EmptyState>
{/if}

<ListDialogs actions={listActions} />

<ListSettingsSheet
	{listId}
	name={membership?.name ?? ''}
	open={settingsOpen}
	onclose={() => (settingsOpen = false)}
/>
