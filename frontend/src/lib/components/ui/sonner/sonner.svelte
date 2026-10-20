<script lang="ts">
	import { mode } from 'mode-watcher';
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';

	let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme={mode.current}
	class="toaster group"
	style="--normal-bg: var(--color-surface); --normal-text: var(--color-foreground); --normal-border: var(--color-border);"
	{...restProps}
>
	<!-- The app sends plain toasts and errors only (#lib/toasts). A failure's one mark ([D-332]); the toast itself stays neutral. -->
	{#snippet errorIcon()}
		<CircleAlertIcon class="size-4 text-danger" />
	{/snippet}
</Sonner>
