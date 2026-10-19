<!--
  §12 settings: the general group ([D-269]), locale, theme, and the names
  hidden from the suggestions (§6.11), which open a sheet to restore them.
  Density is the shopping view's sort menu's ([D-83], [D-271]), and there is
  deliberately no view row ([D-101]).
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import LocaleToggle from '#lib/components/common/LocaleToggle.svelte';
	import { Segmented } from '#lib/components/ui/segmented/index.js';
	import { suppressedNames } from '#lib/state/suppression.js';
	import HiddenSuggestionsSheet from './HiddenSuggestionsSheet.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	// The user's choice, not the resolved `mode.current` (never 'system'), so
	// "System" shows as chosen while it is.
	let themeValue = $derived(userPrefersMode.current);

	function selectMode(m: 'light' | 'dark' | 'system'): void {
		setMode(m);
	}

	// Decided once the mirror has answered, so "keine" never flashes ([D-214]).
	const hiddenLoaded = suppressedNames.loaded;
	let hiddenCount = $derived($suppressedNames.length);
	let hiddenOpen = $state(false);
</script>

<SettingsGroup title={t('settings_general')} icon="⚙️" color="slate">
	<SettingsRow label={t('settings_locale')}>
		{#snippet control()}<LocaleToggle />{/snippet}
	</SettingsRow>
	<SettingsRow label={t('settings_theme')}>
		{#snippet control()}
			<Segmented
				value={themeValue}
				options={[
					{ value: 'light', label: t('settings_theme_light') },
					{ value: 'dark', label: t('settings_theme_dark') },
					{ value: 'system', label: t('settings_theme_system') }
				]}
				onchange={selectMode}
				label={t('settings_theme')}
				testid="settings-theme"
			/>
		{/snippet}
	</SettingsRow>
	{#if hiddenCount > 0}
		<SettingsRow
			label={t('settings_hidden_suggestions')}
			value={String(hiddenCount)}
			opens
			onclick={() => (hiddenOpen = true)}
		/>
	{:else if $hiddenLoaded}
		<SettingsRow
			label={t('settings_hidden_suggestions')}
			value={t('settings_hidden_suggestions_none_value')}
		/>
	{/if}
</SettingsGroup>

<HiddenSuggestionsSheet open={hiddenOpen && hiddenCount > 0} onclose={() => (hiddenOpen = false)} />
