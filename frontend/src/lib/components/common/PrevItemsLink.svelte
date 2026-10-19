<!--
  §6.10/§9.1: the door to the previous-items screen, shared by both views
  ([D-86]). The shop view shows it only when something has aged out; the list
  view always does (`always`), since it is the only route to the screen.

  A settings row with the count as its value and ›, under the untitled group's
  full-bleed rule, which means "a new section" (row rules are inset), and no
  top margin ([D-128]): the rule alone is the break.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { goForward } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import Emoji from './Emoji.svelte';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';

	interface Props {
		listId: string;
		count: number;
		/** §6.10: the list view's always-on routing guarantee. */
		always?: boolean;
	}

	let { listId, count, always = false }: Props = $props();
</script>

{#if always || count > 0}
	<SettingsGroup class="prev-link">
		<SettingsRow
			label={t('history_previous_items')}
			value={count > 0 ? t('history_previous_count', { count }) : undefined}
			valueTestid="prev-n"
			opens
			onclick={() => void goForward(resolve('/list/[id]/previous', { id: listId }))}
		>
			<!-- In the plates' column, so the label stands on the items' line. -->
			{#snippet icon()}<span class="grid size-9.5 place-items-center"
					><Emoji emoji="🕘" size={1.25} /></span
				>{/snippet}
		</SettingsRow>
	</SettingsGroup>
{/if}
