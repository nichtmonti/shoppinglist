<!--
  §6.10 "Frühere Artikel": what this list remembers buying that is not on the
  active list, each row dated ([D-18]) and a one-tap re-add. Its foot clears
  those dates ([D-79]), here rather than in the list's ⋮, since this is
  where they show ([D-271]).
-->
<script lang="ts">
	import { listRememberedItems, listCategories, memberships } from '#lib/state/data.js';
	import { online } from '#lib/state/online.js';
	import { templateLookup } from '#lib/state/template-lookup.js';
	import {
		lastBoughtLabel,
		previousItems,
		sortByName,
		groupByAisle,
		tripEndsAt
	} from '#lib/sorting.js';
	import { nextMidnight } from '#lib/time.js';
	import { Now, earliest } from '#lib/state/clock.svelte.js';
	import { historySort } from '#lib/state/prefs.js';
	import { categoryName, categoryOf } from '#lib/categories.js';
	import { reactivate } from '#lib/actions/items.js';
	import type { Item } from '#lib/db.js';
	import { createTapGuard, tapPoint } from '#lib/components/shop/tap-guard.js';
	import { t } from '#lib/i18n/index.js';
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import AisleHeader from '#lib/components/common/AisleHeader.svelte';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import PreviousItem from './PreviousItem.svelte';
	import EmptyState from '#lib/components/common/EmptyState.svelte';
	import SubScreenTitle from '#lib/components/common/SubScreenTitle.svelte';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import {
		CLEAR_HISTORY_ACTION as clear,
		getListActions
	} from '#lib/components/list/list-actions.svelte.js';

	interface Props {
		listId: string;
	}

	let { listId }: Props = $props();

	let itemsStore = $derived(listRememberedItems(listId));
	let categoriesStore = $derived(listCategories(listId));

	// Distinguishes "nothing bought before" from "Dexie has not answered yet".
	let itemsLoadedStore = $derived(itemsStore.loaded);
	let items = $derived($itemsStore);
	let categories = $derived($categoriesStore);
	let templatesMap = $derived($templateLookup);

	// The list grows when the trip ends ([D-18]), and its wording moves at
	// midnight; `now` ticks at whichever comes first.
	const now = new Now((at) => earliest(tripEndsAt(items, at), nextMidnight(at)));
	let previous = $derived(previousItems(items, now.value));
	let ordered = $derived($historySort === 'az' ? sortByName(previous) : previous);
	let groups = $derived(
		$historySort === 'category' ? groupByAisle(previous, categories, templatesMap) : []
	);

	// The route's, whose dialogs its layout renders.
	const actions = getListActions();
	// The confirmation names the list.
	let listName = $derived($memberships.find((m) => m.list === listId)?.name ?? '');
	// Offered while there is a date to forget, on a previous item or an
	// active row's „Zuletzt" hint.
	let hasDates = $derived(items.some((i) => i.last_bought_at || i.checked_at));

	// A re-added row leaves, and the next one moves up under the finger
	// ([D-213], [D-293]).
	const acceptTap = createTapGuard();
	function readd(item: Item, event: MouseEvent): void {
		if (acceptTap(tapPoint(event))) void reactivate(item);
	}
</script>

<SubScreenTitle title={t('history_previous_items')} />

{#if !$itemsLoadedStore}
	<EmptyState aria-busy="true" />
{:else if previous.length === 0}
	<EmptyState emoji="🧾" title={t('history_empty')} body={t('history_empty_hint')} />
{:else}
	{#if $historySort === 'category'}
		{#each groups as group (group.category.id)}
			<AisleHeader
				title={categoryName(group.category, templatesMap)}
				icon={group.category.icon}
				color={group.category.color}
				count={group.items.length}
			/>
			<!-- Ruled like the list's rows ([D-128], [D-326]). -->
			<RuledRows>
				{#each group.items as item (item.id)}
					<PreviousItem
						{item}
						category={group.category}
						when={lastBoughtLabel(item, now.value)}
						showCategory={false}
						onreadd={(event) => readd(item, event)}
					/>
				{/each}
			</RuledRows>
		{/each}
	{:else}
		<RuledRows inset="var(--row-rule-inset)">
			{#each ordered as item (item.id)}
				<PreviousItem
					{item}
					category={categoryOf(item, categories) ?? null}
					when={lastBoughtLabel(item, now.value)}
					onreadd={(event) => readd(item, event)}
				/>
			{/each}
		</RuledRows>
	{/if}
{/if}

{#if $itemsLoadedStore && hasDates}
	<SettingsGroup class="mt-2">
		<SettingsRow
			label={t(clear.label)}
			opens
			disabled={!$online}
			onclick={() => actions.run(clear.id, listId, listName)}
		>
			{#snippet icon()}<clear.icon aria-hidden="true" />{/snippet}
		</SettingsRow>
		{#snippet footnote()}
			{#if !$online}<OfflineHint />{/if}
		{/snippet}
	</SettingsGroup>
{/if}
