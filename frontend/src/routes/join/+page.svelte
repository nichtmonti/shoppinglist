<!--
  §7.6 invite deep-link. The token is in the URL fragment (§7.1, §10), so it
  never reaches a server log or a Referer header.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import JoinScreen from '#lib/components/share/JoinScreen.svelte';
</script>

<svelte:head>
	<title>{t('common_app_name')}</title>
</svelte:head>

<JoinScreen />
