<!-- §9.3: the app root is the "Meine Listen" home. -->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import ListsHome from '#lib/components/home/ListsHome.svelte';
</script>

<svelte:head>
	<title>{t('common_app_name')}</title>
</svelte:head>

<ListsHome />
