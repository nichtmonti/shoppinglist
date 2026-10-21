<!--
  §9.3's ▾ quick-switcher, triggered by the list title in the app bar: every
  membership (the current one checked) plus a "My lists" row home.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { goAcross, goUp } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
	import { memberships } from '#lib/state/data.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import ListSummary from '#lib/components/list/ListSummary.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import List from '@lucide/svelte/icons/list';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';

	interface Props {
		currentListId: string;
		listName: string;
	}

	let { currentListId, listName }: Props = $props();

	let open = $state(false);

	// Sideways: the list replaces this one in history, so back still leads
	// home. The sheet closes before navigating so the two never race.
	async function switchTo(listId: string) {
		open = false;
		await goAcross(resolve('/list/[id]', { id: listId }));
	}

	async function goHome() {
		open = false;
		await goUp(resolve('/'));
	}

	// SettingsRow's look, around a list's summary ([D-326]).
	const rowClass =
		'flex min-h-13 w-full items-center gap-3 p-1.5 text-start press-row focus-visible:-outline-offset-2';
</script>

<!-- Its box reaches up to the bar's top edge, padding the margin takes back,
     and ends where the line under it begins: the two taps meet without a gap
     or an overlap ([D-296]). -->
<button
	type="button"
	class="relative -mt-1.5 flex min-h-6 w-fit max-w-full cursor-pointer items-center gap-1 pt-1.5 type-title"
	onclick={() => (open = true)}
	title={listName || undefined}
	aria-label={listName ? undefined : t('list_switch_title')}
>
	<span class="truncate">{listName}</span>
	<span class="inline-flex shrink-0 text-faint" aria-hidden="true"
		><ChevronDown class="size-4 shrink-0" /></span
	>
</button>

<Sheet {open} title={t('list_switch_title')} onclose={() => (open = false)}>
	{#if $memberships.length === 1}
		<Hint size="sm" class="py-2">{t('list_switch_none')}</Hint>
	{/if}
	<RuledRows flush>
		{#if $memberships.length > 1}
			{#each $memberships as membership (membership.id)}
				<!-- aria-current, not a label on the check: a label on a plain span is
				     dropped by some screen readers. Marked twice, green and ticked, as
				     a menu's chosen item is; the tick stands where its count would. -->
				<button
					type="button"
					class={[rowClass, membership.list === currentListId && 'text-primary-text']}
					aria-current={membership.list === currentListId ? 'true' : undefined}
					onclick={() => void switchTo(membership.list)}
				>
					<span class="flex min-w-0 flex-1 flex-col gap-1.5">
						<ListSummary {membership} current={membership.list === currentListId} />
					</span>
				</button>
			{/each}
		{/if}
		<SettingsRow label={t('list_switch_all')} flush opens onclick={() => void goHome()}>
			{#snippet icon()}<List aria-hidden="true" />{/snippet}
		</SettingsRow>
	</RuledRows>
</Sheet>
