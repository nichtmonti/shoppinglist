<!--
  §7.1 Share & members sheet: the roster (§7.4) above the list's single active
  invite link, with copy, the system share sheet, a QR code, its expiry,
  "Link zurücksetzen" and "Link zurückziehen" ([D-310]). A list with no live
  link offers "Link erstellen": opening the sheet never mints one ([D-330]).

  The roster refreshes on open, every ROSTER_POLL_MS while open, and once on
  close ([D-236]): the sharer holds the sheet open while the other person
  joins, and the close refresh carries the join to the list header.

  Any member reads the live link's token: the server keeps it beside the hash
  it looks invites up by, behind the member-only rules, and blanks it on
  revocation ([D-294]). A link minted before that has no token, so it shows
  no URL until "Link zurücksetzen" mints one (#lib/actions/invites).
-->
<script lang="ts">
	import OfflineHint from '#lib/components/common/OfflineHint.svelte';
	import Hint from '#lib/components/common/Hint.svelte';
	import { untrack } from 'svelte';
	import { showToast } from '#lib/toasts.js';
	import { t, relativeTime, formatDate } from '#lib/i18n/index.js';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { memberName } from '#lib/member-name.js';
	import { currentAccountId } from '#lib/auth/state.js';
	import { AsyncAction } from '#lib/state/async-action.svelte.js';
	import { listRoster } from '#lib/state/data.js';
	import { refreshRoster } from '#lib/sync/index.js';
	import { online } from '#lib/state/online.js';
	import {
		activeInvite,
		resetInvite,
		revokeInvite,
		inviteUrl,
		type Invite
	} from '#lib/actions/invites.js';
	import Sheet from '#lib/components/ui/Sheet.svelte';
	import ConfirmDialog from '#lib/components/ui/ConfirmDialog.svelte';
	import RuledRows from '#lib/components/common/RuledRows.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { fieldClass } from '#lib/components/ui/input/field-class.js';
	import { cn } from '#lib/utils.js';
	import { Segmented } from '#lib/components/ui/segmented/index.js';
	import Link from '@lucide/svelte/icons/link';
	import QrCode from '@lucide/svelte/icons/qr-code';
	import Share from '@lucide/svelte/icons/share';
	import Copy from '@lucide/svelte/icons/copy';

	interface Props {
		open: boolean;
		listId: string;
		onclose: () => void;
	}

	let props: Props = $props();

	/** How often the open sheet re-reads the roster ([D-236]). */
	const ROSTER_POLL_MS = 5000;

	let rosterStore = $derived(listRoster(props.listId));
	let roster = $derived($rosterStore);
	// Read once per render: the account cannot change while the sheet is open
	// (a sign-out unmounts it), and no store carries the id.
	let myAccountId = $derived(currentAccountId());

	// Only the open list's invite is shown, so switching lists cannot flash or
	// share the previous list's link.
	let invite = $state<Invite | null>(null);
	let shown = $derived(invite?.list === props.listId ? invite : null);
	// Loading, resetting and revoking share one busy/error slot, so only the
	// latest of them writes. Which of them failed decides the retry: a failed
	// load loads again, a failed reset, whose rotation may have committed,
	// offers the reset again ([D-293]), and a failed revoke keeps its button,
	// since revoking twice is harmless.
	const inviteAction = new AsyncAction();
	let lastRun = $state<'load' | 'change'>('load');
	// Both retire the link already sent ([D-31]), so both are confirmed.
	let confirming = $state<'reset' | 'revoke' | null>(null);
	// No live link until one is created ([D-330]).
	let linkless = $state(false);
	let tab = $state<'link' | 'qr'>('link');
	let copied = $state(false);
	// The copy's confirmation on one timer: a second copy restarts it, and
	// closing the sheet drops it, so it cannot cut a later one short.
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	let url = $derived(shown?.token ? inviteUrl(shown.token) : null);
	// qrcode-generator (44K) is imported dynamically, once the QR tab opens,
	// to keep it off every route that merely might share a list. A failed
	// chunk load draws nothing; the link tab still shares the invite.
	let qrMarkup = $derived(tab === 'qr' && url ? buildQrSvg(url).catch(() => '') : null);

	async function loadShareData(listId: string): Promise<void> {
		lastRun = 'load';
		const a = await inviteAction.run(() => activeInvite(listId));
		if (!a.ok) return;
		invite = a.value;
		linkless = !a.value;
	}

	// Each open (or list change) starts the sheet fresh.
	$effect(() => {
		const isOpen = props.open;
		const listId = props.listId;
		if (!isOpen || !listId) return;
		inviteAction.reset();
		tab = 'link';
		copied = false;
		confirming = null;
		linkless = false;
		const refresh = () => void refreshRoster(listId).catch(() => {});
		refresh();
		// The timer and the teardown run untracked, so reading $online there
		// never makes a reconnect start the sheet over.
		const poll = setInterval(() => {
			if ($online && !document.hidden) refresh();
		}, ROSTER_POLL_MS);
		return () => {
			clearInterval(poll);
			clearTimeout(copiedTimer);
			if ($online) refresh();
		};
	});

	// The invite loads on open and on reconnect; a reconnect resets nothing
	// the user is looking at.
	$effect(() => {
		const isOpen = props.open;
		const listId = props.listId;
		if (!isOpen || !listId || !$online) return;
		untrack(() => void loadShareData(listId));
	});

	async function handleReset(): Promise<void> {
		const listId = props.listId;
		if (!listId) return;
		// Creating the first link retires nothing, so it says nothing either.
		const hadLink = shown !== null;
		lastRun = 'change';
		// The confirmation stays open until the answer, and shows a failure in
		// place, as every confirm does.
		const attempt = await inviteAction.run(async () => {
			try {
				const inv = await resetInvite(listId);
				invite = inv;
				linkless = false;
				tab = 'link';
				copied = false;
				// Done-messages are toasts, as everywhere else in the app.
				if (hadLink) showToast(t('share_reset_done'));
			} catch (e) {
				// The rotation [D-31] may have committed with the response lost,
				// so the link on screen may be dead: drop it, and leave the error
				// and the retry.
				invite = null;
				tab = 'link';
				throw e;
			}
		});
		if (attempt.ok) confirming = null;
	}

	async function handleRevoke(): Promise<void> {
		const listId = props.listId;
		if (!listId) return;
		lastRun = 'change';
		const attempt = await inviteAction.run(() => revokeInvite(listId));
		if (!attempt.ok) return;
		confirming = null;
		invite = null;
		linkless = true;
		showToast(t('share_revoke_done'));
	}

	async function handleCopy(value: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => (copied = false), 2000);
		} catch {
			/* clipboard unavailable — the link is still selectable/visible text */
		}
	}

	async function handleShare(value: string): Promise<void> {
		if (navigator.share) {
			try {
				await navigator.share({ url: value });
			} catch {
				/* user cancelled the system share sheet — not an error */
			}
		} else {
			await handleCopy(value);
		}
	}

	async function buildQrSvg(value: string): Promise<string> {
		const qrcode = (await import('qrcode-generator')).default;
		const qr = qrcode(0, 'M');
		qr.addData(value);
		qr.make();
		return qr.createSvgTag({ scalable: true });
	}
</script>

{#snippet redWord(label: string, onclick: () => void, cls = '-mx-2.5 self-start')}
	<!-- A red word, not a red slab ([D-280]): resetting and revoking are rare
	     and can be redone, so neither should be the loudest thing in the sheet. -->
	<Button
		variant="ghost-destructive"
		size="sm"
		class="gap-1.5 {cls}"
		disabled={inviteAction.busy}
		{onclick}
	>
		{label}
	</Button>
{/snippet}

{#snippet resetButton(cls?: string)}
	{@render redWord(
		t('share_reset_link'),
		() => (shown ? (confirming = 'reset') : void handleReset()),
		cls
	)}
{/snippet}

{#snippet youBadge()}<Badge tone="primary">{t('share_you')}</Badge>{/snippet}

<Sheet open={props.open} title={t('share_title')} onclose={props.onclose}>
	<RuledRows flush class="roster">
		{#each roster as m (m.id)}
			{@const me = m.account === myAccountId}
			<SettingsRow
				label={memberName(m.nickname)}
				flush
				hint={me ? undefined : t('share_joined', { when: relativeTime(m.joined) })}
				control={me ? youBadge : undefined}
			/>
		{/each}
	</RuledRows>

	{#if !$online}
		<OfflineHint message={t('share_online_only')} />
	{:else}
		<!-- While a confirmation is open, it shows the error itself. -->
		{#if inviteAction.error && !confirming}
			<ErrorText>{inviteAction.error}</ErrorText>
		{/if}
		{#if shown}
			<!-- On the sheet itself under a rule, not in a box of its own: a box in
			     the sheet, with the QR's frame inside it, nested three deep ([D-280]). -->
			<div class="flex flex-col gap-3 border-t border-border pt-4">
				{#if url}
					<!-- The band: its chosen side stands out against the track. -->
					<Segmented
						variant="band"
						value={tab}
						options={[
							{ value: 'link', label: t('share_invite_link'), icon: Link },
							{ value: 'qr', label: t('share_qr'), icon: QrCode }
						]}
						onchange={(v) => (tab = v)}
						label={t('share_invite_link') + ' / ' + t('share_qr')}
						testid="share-mode"
					>
						{#snippet panel(mode)}
							{#if mode === 'link'}
								<div class="flex flex-col gap-2">
									<div
										class={cn(fieldClass, 'invite-link font-mono text-sm text-muted-foreground')}
										data-testid="invite-link"
									>
										<span class="block truncate" dir="ltr">{url}</span>
									</div>
									<!-- Sharing is the sheet's job, so it is the primary ([D-284]). -->
									<div class="grid grid-cols-2 gap-2">
										<Button onclick={() => void handleShare(url)}>
											<Share aria-hidden="true" />
											{t('share_share')}
										</Button>
										<Button variant="outline" onclick={() => void handleCopy(url)}>
											<Copy aria-hidden="true" />
											{copied ? t('share_copied') : t('share_copy')}
										</Button>
									</div>
								</div>
							{:else}
								<div class="flex flex-col items-center gap-1.5">
									<div
										class="qr size-33 bg-surface border border-border rounded-card p-2 [&_svg]:block [&_svg]:size-full"
										data-testid="qr"
									>
										<!-- eslint-disable-next-line svelte/no-at-html-tags -- our own qrcode-generator SVG over a URL we minted (crypto-random token, §7.1); never user-supplied HTML. -->
										{#await qrMarkup then svg}{@html svg}{/await}
									</div>
									<Hint>{t('share_qr_caption')}</Hint>
								</div>
							{/if}
						{/snippet}
					</Segmented>
				{:else}
					<Hint>{t('share_link_unavailable')}</Hint>
				{/if}
				<div class="text-center">
					<Hint class="expiry">
						{t('share_expiry', { date: formatDate(shown.expires_at) })}
					</Hint>
					<!-- Under the expiry, which in German leaves no room beside two of
					     them on a phone ([D-310]), on the buttons' two columns. -->
					<div class="grid grid-cols-2 gap-2">
						{@render resetButton('w-full')}
						{@render redWord(t('share_revoke_link'), () => (confirming = 'revoke'), 'w-full')}
					</div>
				</div>
			</div>
		{:else if linkless}
			<!-- [D-330] No live link: nobody can join until a member creates one. -->
			<div class="flex flex-col gap-3 border-t border-border pt-4">
				<Hint>{t('share_no_link')}</Hint>
				<Button type="button" disabled={inviteAction.busy} onclick={() => void handleReset()}>
					{t('share_create_link')}
				</Button>
			</div>
		{:else if inviteAction.error && lastRun === 'load'}
			<!-- Loading failed: nothing was changed, so the retry only loads again. -->
			<Button
				type="button"
				disabled={inviteAction.busy}
				onclick={() => props.listId && void loadShareData(props.listId)}
			>
				{t('common_retry')}
			</Button>
		{:else if inviteAction.error}
			<!-- A reset failed and may have committed: the retry resets again. -->
			{@render resetButton()}
		{/if}
	{/if}
</Sheet>

{#if confirming}
	{@const reset = confirming === 'reset'}
	<ConfirmDialog
		open
		title={t(reset ? 'share_reset_link' : 'share_revoke_link')}
		body={t('share_link_stops_confirm')}
		confirmLabel={t(reset ? 'share_reset_confirm_action' : 'share_revoke_confirm_action')}
		danger
		busy={inviteAction.busy}
		error={inviteAction.error}
		onconfirm={() => void (reset ? handleReset() : handleRevoke())}
		oncancel={() => (confirming = null)}
	/>
{/if}
