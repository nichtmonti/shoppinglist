<!--
  In place of the whole app where the browser gives the page no secure
  context: plain http:// at any address but this machine's ([D-335]).
  Passkeys, the service worker and the functions the sync needs are withheld
  there, so the app would look fine and save nothing.
-->
<script lang="ts">
	import FocusScreen from './FocusScreen.svelte';
	import FocusTitle from './FocusTitle.svelte';
	import Hint from './Hint.svelte';
	import { t } from '#lib/i18n/index.js';

	const localUrl = `http://localhost${location.port ? `:${location.port}` : ''}`;
</script>

<FocusScreen role="alert">
	<FocusTitle title={t('insecure_title')} locale />
	<Hint size="sm">{t('insecure_body', { url: localUrl })}</Hint>
</FocusScreen>
