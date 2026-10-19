<!--
  The demo's notice ([D-234]): when this account is deleted. Once it is, the
  session is rejected (§5.8) and the notice offers a fresh demo, as the sync
  chip's re-auth does (state/reauth.svelte.ts).
-->
<script lang="ts">
	import { authState, logout } from '#lib/auth/index.js';
	import { t } from '#lib/i18n/index.js';
	import { Now } from '#lib/state/clock.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { demoEndsAt } from './start';

	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;

	// Each minute: the last hour counts minutes.
	const now = new Now((at) => at + MINUTE);
	let endsAt = $derived($authState.nickname === null ? null : demoEndsAt());
	let left = $derived(endsAt === null ? null : endsAt - now.value);
	let expired = $derived(!$authState.isValid || (left !== null && left <= 0));

	let text = $derived.by(() => {
		if (left === null) return t('demo_banner');
		if (left >= HOUR) return t('demo_banner_hours', { count: Math.ceil(left / HOUR) });
		return t('demo_banner_minutes', { count: Math.max(1, Math.ceil(left / MINUTE)) });
	});
</script>

<div
	class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-surface-2 px-4 py-1.5 text-center text-meta text-muted-foreground"
	role="status"
	data-testid="demo-banner"
>
	{#if expired}
		<span>{t('demo_expired')}</span>
		<Button variant="outline" size="sm" type="button" onclick={() => void logout()}>
			{t('demo_restart')}
		</Button>
	{:else}
		<span>{text}</span>
	{/if}
</div>
