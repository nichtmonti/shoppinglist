<!--
  A sheet's or a dialog's ✕: the secondary's white and firm edge as a circle,
  so it reads as a button at a glance ([D-312]). One part, so the scan dialog
  cannot draw its own. `done` is a sheet that keeps what was typed as it
  closes: a ✓ in soft green named „Fertig“, set 16px from the sheet's other
  actions; its press stays grey, as every press does ([D-355], [D-321]).
-->
<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import Check from '@lucide/svelte/icons/check';
	import { t } from '#lib/i18n/index.js';
	import type { ComponentProps } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		label,
		done = false,
		...rest
	}: ComponentProps<typeof Button> & { label?: string; done?: boolean } = $props();
</script>

<Button
	{...rest}
	variant="outline"
	size="icon"
	class={done
		? 'ms-3 rounded-full border-primary-line bg-primary-soft text-primary-text'
		: 'rounded-full'}
	aria-label={label ?? t(done ? 'common_done' : 'common_close')}
>
	{#if done}<Check class="size-4.5" />{:else}<X class="size-4.5" />{/if}
</Button>
