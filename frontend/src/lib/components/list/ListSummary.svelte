<!--
  A list's summary — its name, then the unsynced badge and the remaining
  count on the right ([D-123]) — shared by the home card and the list
  switcher's rows. The count is a bare number, a grey tick when nothing is
  open, nothing when the list is empty; its words are for screen readers.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import type { MyList } from '#lib/state/data.js';
	import { listCounts, listIndex, outbox } from '#lib/state/data.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import Check from '@lucide/svelte/icons/check';
	interface Props {
		membership: MyList;
		/** 2 lets a long name wrap (the home card, [D-90]). */
		nameLines?: 1 | 2;
		/** Ids for the status lines, `<idBase>-pending` and `<idBase>-counts`,
		 *  so a card whose summary is hidden can describe its link by them. */
		idBase?: string;
		/** The switcher's own list: its green tick takes the count's place,
		 *  since that list is on screen behind it. */
		current?: boolean;
	}

	let { membership, nameLines = 1, idBase, current = false }: Props = $props();

	let listId = $derived(membership.list);
	// Counted in the index: a card reads no row ([D-308]).
	let countsStore = $derived(listCounts(listId));
	let counts = $derived($countsStore);
	// No count until it is true ([D-185]): not before IndexedDB answered, and
	// not before the first cycle pulled this list's items, which a `lists`
	// row's `updated` signals (cycle.ts writes it after the items).
	let itemsLoaded = $derived(countsStore.loaded);
	let pulled = $derived($listIndex.some((l) => l.id === listId && l.updated !== undefined));
	let outboxStore = $derived(outbox(listId));
	let pending = $derived($outboxStore.length);

	// §9.3: what remains to buy, else "alles erledigt ✓", else "leer".
	let open = $derived(counts.open);
	let total = $derived(counts.open + counts.done);
	let known = $derived($itemsLoaded && pulled);

	let countLabel = $derived(
		!known
			? ''
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
	<span class="flex flex-none items-center gap-2.5">
		{#if pending > 0}
			<Badge id={idBase && `${idBase}-pending`} tone="amber" data-testid="card-unsynced">
				<i class="dot size-1.5 rounded-full bg-amber" aria-hidden="true"></i>{t(
					'home_card_unsynced',
					{ count: pending }
				)}
			</Badge>
		{/if}
		{#if current}
			<Check class="size-4.5 shrink-0 text-primary-text" aria-hidden="true" />
		{:else if known && open > 0}
			<span class="type-heading tabular-nums" aria-hidden="true">{open}</span>
		{:else if known && total > 0}
			<Check class="size-4.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
	</span>
</span>
<span class="sr-only" id={idBase && `${idBase}-counts`}>{countLabel}</span>
