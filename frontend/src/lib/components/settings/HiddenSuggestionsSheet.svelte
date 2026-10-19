<!--
  §6.11's second un-suppression path (the first is re-adding the name): the
  sheet behind settings' "Ausgeblendete Vorschläge" row ([D-269]), to restore
  names the typeahead no longer offers. It shows the stored normalized forms
  ([D-44]), which are what is actually suppressed. Restoring the last one
  closes it, through the caller's `open`.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { suppressedNames, unsuppressName } from '#lib/state/suppression.js';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import { WRAP_BUTTON_CLASS } from './surface';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	let hidden = $derived($suppressedNames);

	// Works offline, like suppressing ([D-137]).
	async function restoreSuggestion(name: string): Promise<void> {
		await unsuppressName(name);
	}
</script>

<Sheet {open} title={t('settings_hidden_suggestions')} {onclose}>
	<RuledRows flush>
		{#each hidden as name (name)}
			<SettingsRow label={name} flush>
				<!-- Described by its name: five „Wieder vorschlagen“ in a row must say which. -->
				{#snippet control(labelId)}
					<Button
						variant="outline"
						size="sm"
						type="button"
						class={WRAP_BUTTON_CLASS}
						aria-describedby={labelId}
						onclick={() => void restoreSuggestion(name)}
					>
						{t('settings_unsuppress')}
					</Button>
				{/snippet}
			</SettingsRow>
		{/each}
	</RuledRows>
</Sheet>
