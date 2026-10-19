<!--
  §12 settings: installing the app ([D-231]), while it runs in a browser tab.
  The row opens Chromium's install dialog where offered, the steps
  elsewhere. The dismissable banner offers the same; here it stays findable.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { currentPlatform, install, promptInstall } from '#lib/install.svelte.js';
	import InstallGuideSheet from '#lib/components/install/InstallGuideSheet.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	const platform = currentPlatform();
	let guideOpen = $state(false);
</script>

{#if !install.standalone}
	<SettingsGroup title={t('settings_section_app')} icon="📱" color="green">
		{#if install.installed}
			<SettingsRow label={t('settings_install_title')} hint={t('settings_install_done')} />
		{:else}
			<SettingsRow
				label={t('settings_install_title')}
				hint={t('settings_install_body')}
				opens
				onclick={() => {
					if (install.deferred) void promptInstall();
					else guideOpen = true;
				}}
			/>
		{/if}
	</SettingsGroup>
	<InstallGuideSheet open={guideOpen} {platform} onclose={() => (guideOpen = false)} />
{/if}
