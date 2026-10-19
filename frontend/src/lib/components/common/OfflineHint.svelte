<!--
  Why a control that needs the server is greyed out: shown directly under it
  while offline ([D-325]). `message` words it for the screen when the
  general sentence does not fit; a caller's `class` adds its spacing.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import Hint from './Hint.svelte';

	let { message, class: className }: { message?: string; class?: string } = $props();
</script>

<Hint class={className}>{message ?? t('common_offline_hint')}</Hint>
