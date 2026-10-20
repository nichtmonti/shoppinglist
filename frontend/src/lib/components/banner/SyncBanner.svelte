<!--
  §12.1 sync-status chip. Its state is `syncStatus`'s chip (sync-status.ts),
  the same answer the line under the list's name reads:

    synced   (N=0, online, valid session)  → "All synced"
    pending  (N>0, online, valid session)  → "N not synced yet…"
    stale    (N=0, tries failing, no answer for 5 min) → "No answer since <time>" ([D-296])
    offline                                → "Offline · N pending · last synced <time>"
    expired  (online, session no longer valid) → one-tap §5.8 re-auth

  What is wrong beyond the count, and what helps, is the line under the list's
  name (SyncLine.svelte); the chip stays one glyph ([D-102]).

  A 26x26 chip left of the app bar's title, always present (so "synced" can be
  read rather than inferred) and the same box in every state, so nothing moves
  when the state changes. Each state's sentence is .sr-only: the chip's
  accessible name and the live region's announcement.

  It mounts in every app bar ([D-130]): the expired state can be reached from
  any screen, so the control that clears it must be there too.
-->
<script lang="ts">
	import { t, relativeTime } from '#lib/i18n/index.js';
	import { lastSyncedAt } from '#lib/state/data.js';
	import { syncStatus, type ChipState } from '#lib/state/sync-status.js';
	import { Reauth } from '#lib/state/reauth.svelte.js';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import Clock from '@lucide/svelte/icons/clock';
	import KeyRound from '@lucide/svelte/icons/key-round';

	interface Props {
		/**
		 * The list on screen, whose outbox the count reports; omitted, the count
		 * is the whole device's outbox ([D-130]).
		 */
		listId?: string;
	}

	let { listId = '' }: Props = $props();

	let syncedAt = $derived($lastSyncedAt);
	let statusStore = $derived(syncStatus(listId));
	let status = $derived($statusStore);
	let bannerState = $derived(status.chip);
	let pending = $derived(status.pending);

	const bannerBase =
		'size-6.5 shrink-0 grid place-items-center rounded-chip border transition-colors duration-220';
	// [D-102]: no two states share a glyph, and the one actionable
	// state is the only filled chip.
	const bannerTone: Record<ChipState, string> = {
		synced: 'border-primary-line bg-primary-soft text-primary-text',
		pending: 'border-amber-line bg-amber-soft text-amber',
		expired: 'border-transparent bg-danger text-danger-foreground',
		offline: 'border-line-strong bg-surface-2 text-muted-foreground',
		// Offline's grey, a clock instead of its struck cloud: nothing of the
		// user's is at risk, what is shown may be old.
		stale: 'border-line-strong bg-surface-2 text-muted-foreground'
	};

	let whenText = $derived(syncedAt ? relativeTime(syncedAt) : t('banner_never_synced'));

	// The inert states' sentence, as tooltip and .sr-only text.
	let sentence = $derived(
		bannerState === 'offline'
			? pending > 0
				? t('banner_offline_pending', { count: pending })
				: t('banner_offline')
			: bannerState === 'pending'
				? t('banner_pending', { count: pending })
				: status.line.kind === 'broken'
					? t('sync_broken_title')
					: bannerState === 'stale'
						? t('sync_stale_sentence', {
								when:
									status.line.kind === 'stale' && status.line.since
										? relativeTime(status.line.since)
										: t('sync_line_never')
							})
						: t('banner_synced')
	);

	// The chip has nowhere to render an error; Reauth toasts its failures
	// ([D-130]).
	const reauth = new Reauth();
</script>

<!--
  The wrapper is the one permanent live region for all four states: were it
  inside a branch, switching to expired would tear it down and silence the
  one state that needs action. It owns the fixed 26x26 box; the chip inside
  only paints it. In the expired state the whole chip is the button.
-->
<div class="chip size-6.5 shrink-0" role="status" aria-live="polite" aria-label={t('banner_label')}>
	{#if bannerState === 'expired'}
		<!-- WCAG 2.5.5: hit-target enlarges the 26px chip's target to 44px
		     without changing the painted box. -->
		<button
			type="button"
			class="banner expired reauth {bannerBase} {bannerTone.expired} relative cursor-pointer hit-target"
			onclick={() => void reauth.run()}
			disabled={reauth.busy && !reauth.pendingOidc}
			aria-busy={reauth.busy}
			title={t('banner_expired')}
		>
			<KeyRound class="size-4 shrink-0" aria-hidden="true" />
			<span class="sr-only">{t('banner_expired')}</span>
		</button>
	{:else}
		<!-- A native title, not a tooltip component: it only repeats the
		     sr-only sentence. -->
		<div class="banner {bannerState} {bannerBase} {bannerTone[bannerState]}" title={sentence}>
			{#if pending > 0 && (bannerState === 'pending' || bannerState === 'offline')}
				<!-- [D-102]: the count is the glyph, visible on touch where a title
				     never shows. aria-hidden: the sentence already announces it.
				     Capped at 99+ so three digits cannot crowd the box. -->
				<span class="text-micro font-bold leading-none" aria-hidden="true"
					>{pending > 99 ? '99+' : pending}</span
				>
			{:else if bannerState === 'offline'}
				<CloudOff class="size-4 shrink-0" />
			{:else if bannerState === 'stale'}
				<Clock class="size-4 shrink-0" />
			{:else}
				<Cloud class="size-4 shrink-0" />
			{/if}
			<!-- Only offline carries a timestamp: there staleness is the message. -->
			<span class="sr-only">{sentence}</span>
			{#if bannerState === 'offline'}
				<span class="sr-only when">{t('banner_synced_when', { when: whenText })}</span>
			{/if}
		</div>
	{/if}
</div>
