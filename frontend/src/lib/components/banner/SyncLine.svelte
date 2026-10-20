<!--
  The line under a list's name ([D-296]): its members, or, when the sync is
  not fine, what is wrong. Amber when something of the user's is not getting
  out or the app itself fails, grey for news with nothing at risk. A tap opens what it says: the
  members open „Teilen & Mitglieder“, a status the sheet that says why and
  offers the one thing that helps. One line in both languages: the copy is
  cut to fit a 360px phone.

  Its box reaches down to the tabs, padding the margin takes back, so it is a
  24px target that meets the name's above it without overlapping it.
-->
<script lang="ts">
	import Hint from '#lib/components/common/Hint.svelte';
	import { t, relativeTime } from '#lib/i18n/index.js';
	import { syncStatus, type SyncLine } from '#lib/state/sync-status.js';
	import { syncNow } from '#lib/sync/index.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	interface Props {
		listId: string;
		/** What the line says while the sync is fine. */
		members: string;
		/** Opens the list's members (the share sheet). */
		onmembers: () => void;
	}

	let { listId, members, onmembers }: Props = $props();

	const lineClass =
		'sync-line -mb-1.5 flex min-h-6 max-w-full min-w-0 cursor-pointer items-start gap-0.5 pt-px pb-1.5 text-start text-meta';

	let statusStore = $derived(syncStatus(listId));
	let status = $derived($statusStore.line);
	let open = $state(false);

	function when(since: string | null): string {
		return since ? relativeTime(since, Date.now(), 'short') : t('sync_line_never');
	}

	interface Explained {
		line: string;
		problem: boolean;
		title: string;
		body: string;
		action?: { label: string; run: () => void };
	}

	function explain(s: SyncLine): Explained | null {
		switch (s.kind) {
			case 'failing':
				return {
					line: t(`sync_line_${s.reason}`),
					problem: true,
					title: t('sync_failing_title', { count: s.count }),
					body: `${t(`sync_failing_${s.reason}`)} ${t('sync_failing_kept')}`,
					action: { label: t('sync_send_now'), run: () => syncNow() }
				};
			case 'stale':
				return {
					line: t('sync_line_stale', { when: when(s.since) }),
					problem: false,
					title: t('sync_stale_title'),
					body: t('sync_stale_body'),
					action: { label: t('sync_stale_action'), run: () => syncNow() }
				};
			case 'broken':
				return {
					line: t('sync_line_broken'),
					problem: true,
					title: t('sync_broken_title'),
					body: t('sync_broken_body'),
					action: { label: t('sync_stuck_action'), run: () => location.reload() }
				};
			case 'other_tab':
				// No action: taking the lead could let a woken tab send beside this one ([D-288]).
				return {
					line: t('sync_line_other_tab'),
					problem: true,
					title: t('banner_stalled_title'),
					body: t('banner_stalled_body')
				};
			case 'stuck':
				return {
					line: t('sync_line_stuck'),
					problem: true,
					title: t('sync_stuck_title'),
					body: t('sync_stuck_body'),
					action: { label: t('sync_stuck_action'), run: () => location.reload() }
				};
			case 'offline':
				return {
					line: t('sync_line_offline', { when: when(s.since) }),
					problem: false,
					title: t('banner_offline'),
					body: t('sync_offline_body')
				};
			default:
				return null;
		}
	}

	let explained = $derived(explain(status));

	// A sync that recovers closes what explained it.
	$effect(() => {
		if (!explained) open = false;
	});
</script>

{#if explained}
	<button
		type="button"
		class={[lineClass, explained.problem ? 'font-demi text-amber' : 'text-muted-foreground']}
		aria-haspopup="dialog"
		onclick={() => (open = true)}
		data-testid="sync-line"
	>
		<span class="truncate">{explained.line}</span>
		<ChevronRight class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
	</button>
	<Sheet {open} title={explained.title} onclose={() => (open = false)}>
		<Hint size="sm">{explained.body}</Hint>
		{#if explained.action}
			{@const action = explained.action}
			<Button
				type="button"
				class="w-full"
				onclick={() => {
					open = false;
					action.run();
				}}
			>
				{action.label}
			</Button>
		{/if}
	</Sheet>
{:else}
	<button
		type="button"
		class={[lineClass, 'text-muted-foreground']}
		aria-haspopup="dialog"
		onclick={onmembers}
		data-testid="members-line"
	>
		<span class="truncate">{members}</span>
		<ChevronRight class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
	</button>
{/if}
