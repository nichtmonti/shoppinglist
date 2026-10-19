<!--
  The app's error page ([D-197]), for a route that throws while it loads. While
  a retry is scheduled (route code failed to load, [D-202]) it says only that.
-->
<script lang="ts">
	import Waiting from '#lib/components/common/Waiting.svelte';
	import { page } from '$app/state';
	import FocusScreen from '#lib/components/common/FocusScreen.svelte';
	import ErrorView from '#lib/components/common/ErrorView.svelte';
	import { t } from '#lib/i18n/index.js';
</script>

{#if page.error?.retrying}
	<FocusScreen data-testid="error-retrying">
		<Waiting role="status" title={t('error_page_retrying')} />
	</FocusScreen>
{:else}
	<ErrorView detail={page.error?.detail} notFound={page.status === 404} />
{/if}
