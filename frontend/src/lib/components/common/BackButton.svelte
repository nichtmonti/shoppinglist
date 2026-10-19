<!--
  The back button of the app bar ([D-272]); the caller supplies the target.
  24px wide and 12px into the bar's margin, so a list's chip and title sit
  only 28px right of the home's. Its hit area runs from the screen's edge to
  the chip, 44 by 48px all on screen ([D-56]), and never under the chip, which
  is the re-auth button when a session expires ([D-130]). On a list's
  sub-screens it is the only way back ([D-304]). No tooltip ([D-213]): on a phone it flashed up
  before the navigation.
-->
<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import { t } from '#lib/i18n/index.js';

	let { onclick }: { onclick: (e: MouseEvent) => void } = $props();
</script>

<Button
	variant="ghost"
	size="icon"
	type="button"
	{onclick}
	aria-label={t('common_back')}
	class="me-2 w-6 -ms-3 after:-inset-y-1 after:-left-1 after:-right-4"
>
	<ChevronLeft class="bar-icon size-5.5" />
</Button>
