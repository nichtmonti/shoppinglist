<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import SettingsScreen from '#lib/components/settings/SettingsScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{t('settings_title')}</title>
</svelte:head>

<SettingsScreen passkeys={data.passkeys} />
