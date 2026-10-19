<!--
  §9.3 per-list card: the list's summary and a ⋮ menu of its actions, those
  of the ⋮ inside the list but its categories ([D-270], [D-271]). A card
  opens its list and never drags ([D-90]: arranging is its own mode).

  The shop tile's card pattern ([D-83]): a covering link opens the list, so
  nothing interactive nests inside it; the summary is an aria-hidden,
  click-through layer over it and the menu sits above. A link, not a button
  ([D-90]): opening a list is navigation.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
	import type { MyList } from '#lib/state/data.js';
	import { cn } from '#lib/utils.js';
	import { Card } from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import ListSummary from '#lib/components/list/ListSummary.svelte';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { HOME_ACTIONS, type ListActionId } from '#lib/components/list/list-actions.svelte.js';
	interface Props {
		membership: MyList;
		/** Greys out the actions that need the server. */
		offline: boolean;
		onaction: (id: ListActionId) => void;
	}

	let { membership, offline, onaction }: Props = $props();

	let menuLabel = $derived(t('common_actions_for', { name: membership.name }));
	// The summary is hidden from the accessibility tree; its counts and the
	// unsynced warning still reach a screen reader as the link's description.
	const summaryId = $props.id();
</script>

<Card
	class="press-card relative isolate grid grid-cols-[minmax(0,1fr)_auto] text-start hover:bg-tint"
>
	<a
		class="absolute inset-0 rounded-[inherit]"
		href={resolve('/list/[id]', { id: membership.list })}
		aria-label={t('home_open_list', { name: membership.name })}
		aria-describedby="{summaryId}-counts {summaryId}-pending"
	></a>
	<span
		class="pointer-events-none relative z-1 col-start-1 flex min-w-0 flex-col gap-1.5 py-3.5 ps-3.5 pe-1"
		aria-hidden="true"
	>
		<ListSummary {membership} nameLines={2} idBase={summaryId} />
	</span>
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class={cn(
				buttonVariants({ variant: 'quiet', size: 'icon' }),
				// 40px, not 2.5rem, which would take 80px from the name at 200% text
				// ([D-90]); the icon size's inset keeps it 48px to tap.
				'relative z-1 col-start-2 mt-3.5 me-3.5 size-[40px] self-start'
			)}
			aria-label={menuLabel}
		>
			<EllipsisVertical class="size-5 shrink-0" />
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end">
			{#each HOME_ACTIONS as action (action.id)}
				<DropdownMenu.Item
					variant={action.id === 'leave' ? 'destructive' : 'default'}
					disabled={offline && action.online}
					onSelect={() => onaction(action.id)}
				>
					<action.icon />
					{t(action.label)}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</Card>
