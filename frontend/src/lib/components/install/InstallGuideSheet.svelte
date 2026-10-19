<!--
  The steps to add the app to the home screen by hand ([D-231]), for every
  browser that does not offer installation itself, in the browser's own
  labels and icons. The last line is for an in-app browser, which cannot
  install and cannot be told apart reliably.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import type { Component } from 'svelte';
	import Share from '@lucide/svelte/icons/share';
	import SquarePlus from '@lucide/svelte/icons/square-plus';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { t } from '#lib/i18n/index.js';
	import type { InstallPlatform } from '#lib/install.svelte.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';

	let {
		open,
		platform,
		onclose
	}: { open: boolean; platform: InstallPlatform; onclose: () => void } = $props();

	type Step = { text: string; icon?: Component };

	let steps = $derived<Step[]>(
		platform === 'ios'
			? [
					{ text: t('install_ios_1'), icon: Share },
					{ text: t('install_ios_2'), icon: SquarePlus },
					{ text: t('install_ios_3') }
				]
			: platform === 'android'
				? [
						{ text: t('install_android_1'), icon: EllipsisVertical },
						{ text: t('install_android_2') },
						{ text: t('install_confirm') }
					]
				: [
						{ text: t('install_other_1') },
						{ text: t('install_other_2') },
						{ text: t('install_confirm') }
					]
	);

	let fallback = $derived(
		platform === 'ios'
			? t('install_fallback_ios')
			: platform === 'android'
				? t('install_fallback_android')
				: t('install_fallback_other')
	);
</script>

<Sheet {open} title={t('install_guide_title')} {onclose}>
	<ol class="flex flex-col gap-3" data-testid="install-steps" data-platform={platform}>
		{#each steps as step, i (i)}
			<li class="flex items-start gap-3">
				<span
					class="flex size-7 shrink-0 items-center justify-center rounded-full bg-tint-strong text-sm font-bold"
					aria-hidden="true">{i + 1}</span
				>
				<span class="min-w-0 flex-1 pt-0.5 wrap-break-word hyphens-auto">{step.text}</span>
				{#if step.icon}
					<step.icon class="mt-0.5 size-6 shrink-0 text-primary-text" aria-hidden="true" />
				{/if}
			</li>
		{/each}
	</ol>
	{#if platform === 'ios'}
		<!-- A home-screen app on iOS keeps its own storage, apart from Safari's:
		     the session signed in here does not come along. -->
		<Hint>{t('install_ios_signin')}</Hint>
	{/if}
	<Hint>{fallback}</Hint>
</Sheet>
