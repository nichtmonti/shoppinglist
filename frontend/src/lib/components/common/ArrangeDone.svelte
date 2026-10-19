<!--
  An arrange mode's one way out, "Fertig" ([D-90]), for the home's and the
  category editor's, at the screen's foot.
-->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import StickyFoot from './StickyFoot.svelte';

	let { ondone, class: className }: { ondone: () => void; class?: string } = $props();
</script>

<StickyFoot class={className}>
	<Button type="button" onclick={ondone}>
		{t('arrange_done')}
	</Button>
</StickyFoot>
