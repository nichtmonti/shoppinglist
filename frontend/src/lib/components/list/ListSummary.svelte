<!--
  A list's summary — name, remaining count, member count and unsynced badge —
  shared by the home card and the list switcher's rows.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import type { MyList } from '#lib/state/data.js';
	import { listCounts, listIndex, listRoster, outbox } from '#lib/state/data.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	interface Props {
		membership: MyList;
		/** 2 lets a long name wrap (the home card, [D-90]). */
		nameLines?: 1 | 2;
		/** Ids for the status lines, `<idBase>-pending` and `<idBase>-counts`,
		 *  so a card whose summary is hidden can describe its link by them. */
		idBase?: string;
	}

	let { membership, nameLines = 1, idBase }: Props = $props();

	let listId = $derived(membership.list);
	// Counted in the index: a card reads no row ([D-308]).
	let countsStore = $derived(listCounts(listId));
	let counts = $derived($countsStore);
	// No count until it is true ([D-185]): not before IndexedDB answered, and
	// not before the first cycle pulled this list's items, which a `lists`
	// row's `updated` signals (cycle.ts writes it after the items).
	let itemsLoaded = $derived(countsStore.loaded);
	let pulled = $derived($listIndex.some((l) => l.id === listId && l.updated !== undefined));
	let rosterStore = $derived(listRoster(listId));
	let roster = $derived($rosterStore);
	let outboxStore = $derived(outbox(listId));
	let pending = $derived($outboxStore.length);

	// §9.3: what remains to buy, else "alles erledigt ✓", else "leer".
	let open = $derived(counts.open);
	let total = $derived(counts.open + counts.done);
	// An empty roster cache (never refreshed, §7.4) reads as not shared.
	let shared = $derived(roster.length > 1);

	let countLabel = $derived(
		!$itemsLoaded || !pulled
			? '\u00a0' // keeps the line's height, so the card does not grow when it lands
			: total === 0
				? t('home_card_empty')
				: open === 0
					? t('home_card_all_done')
					: t('home_card_counts', { open })
	);
</script>

<span class="flex items-center gap-2">
	<span
		class="type-heading min-w-0 flex-1 {nameLines === 2
			? 'line-clamp-2 wrap-break-word hyphens-auto'
			: 'truncate  '}"
		dir="auto">{membership.name}</span
	>
	<span class="flex flex-none items-center gap-2.5 text-sm">
		{#if pending > 0}
			<Badge id={idBase && `${idBase}-pending`} tone="amber">
				<i class="dot size-1.5 rounded-full bg-amber" aria-hidden="true"></i>{t(
					'home_card_unsynced',
					{ count: pending }
				)}
			</Badge>
		{/if}
	</span>
</span>
<span class="flex items-baseline gap-1.5 text-meta" id={idBase && `${idBase}-counts`}>
	<span
		class={[
			total > 0 && open === 0 ? 'text-primary-text font-demi' : 'text-muted-foreground',
			total === 0 && 'italic'
		]}
	>
		{countLabel}
	</span>
	{#if shared}
		<span class="text-muted-foreground">· {t('home_card_members', { count: roster.length })}</span>
	{/if}
</span>
