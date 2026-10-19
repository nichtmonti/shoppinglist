<!--
  A sheet's or a dialog's ✕: the secondary's white and firm edge as a circle,
  so it reads as a button at a glance ([D-312]). One part, so the scan dialog
  cannot draw its own.
-->
<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import { t } from '#lib/i18n/index.js';
	import type { ComponentProps } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	let { label, ...rest }: ComponentProps<typeof Button> & { label?: string } = $props();
</script>

<Button
	{...rest}
	variant="outline"
	size="icon"
	class="rounded-full"
	aria-label={label ?? t('common_close')}
>
	<X class="size-4.5" />
</Button>
