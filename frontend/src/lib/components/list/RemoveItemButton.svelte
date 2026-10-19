<!-- Shared header action for the item detail sheet and its live gallery fixture. -->
<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	interface Props {
		name: string;
		onremove?: () => void;
	}

	let { name, onremove }: Props = $props();
</script>

<Button
	variant="destructive"
	size="icon"
	class="rounded-full"
	onclick={() => onremove?.()}
	aria-label={t('list_remove', { name })}
>
	<Trash2 class="shrink-0" />
</Button>
