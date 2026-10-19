<!--
  §7.6 invite deep-link: preview then join. The token travels in the URL
  fragment so it never reaches a server log or Referer header (§7.1/§10). The
  preview needs no account; only the join is gated, in three states as in the
  app shell (§5.8):

    isValid              → the join button;
    nickname !== null    → a known device whose session expired: one-tap
                           re-auth, never the create-account screen;
    otherwise            → a visitor: AuthScreen inline.

  A token the server refuses renders the one generic message: never
  distinguish revoked/expired/not-found (§7.6). A request that did not get
  that answer (offline, a server error, a rate limit) says so and offers to
  try again ([D-292]).
-->
<script lang="ts">
	import Waiting from '#lib/components/common/Waiting.svelte';
	import Hint from '#lib/components/common/Hint.svelte';
	import { displayName as itemDisplayName } from '#lib/item-name.js';
	import { onMount } from 'svelte';
	import { goAcross } from '#lib/history-layers.svelte.js';
	import { resolve } from '$app/paths';
	import { getLocale, t } from '#lib/i18n/index.js';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import { authState } from '#lib/auth/index.js';
	import ReauthButton from '#lib/components/common/ReauthButton.svelte';
	import { previewInvite, joinList, type ListPreview } from '#lib/actions/lists.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cardSurface } from '#lib/components/ui/card/card-surface.js';
	import FocusScreen from '#lib/components/common/FocusScreen.svelte';
	import FocusTitle from '#lib/components/common/FocusTitle.svelte';
	import AuthScreen from '#lib/components/auth/AuthScreen.svelte';
	import { clearJoinToken, joinToken } from '#lib/components/share/join-token.js';
	import { httpStatus } from '#lib/http-status.js';

	let token = $state('');
	let preview = $state<ListPreview | null>(null);
	let loading = $state(true);
	let joining = $state(false);
	// `invalid` is the server refusing the token; the others are a request
	// that never got an answer about it.
	let failure = $state<'invalid' | 'preview_failed' | 'join_failed' | null>(null);

	// A taste of the list, not the list: the first few names in one sentence,
	// "Milch, Brot und 12 weitere". Quantities stay out; the visitor decides
	// on the names.
	const PREVIEW_NAMES = 5;
	let previewNames = $derived.by(() => {
		if (!preview?.items.length) return '';
		const names = preview.items.slice(0, PREVIEW_NAMES).map((i) => itemDisplayName(i));
		const rest = preview.items.length - names.length;
		if (rest > 0) names.push(t('share_join_more', { count: rest }));
		return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(names);
	});

	// The server refuses a dead token with a 400 (§7.6); anything else, a
	// network error included, says nothing about the token.
	function refused(e: unknown): boolean {
		const status = httpStatus(e);
		return status === 400 || status === 404;
	}

	onMount(() => {
		token = joinToken();
		void loadPreview();
	});

	async function loadPreview(): Promise<void> {
		loading = true;
		failure = null;
		if (!token) {
			failure = 'invalid';
			loading = false;
			return;
		}
		try {
			preview = await previewInvite(token);
		} catch (e) {
			failure = refused(e) ? 'invalid' : 'preview_failed';
		} finally {
			loading = false;
		}
	}

	function leave(): void {
		clearJoinToken();
		void goAcross(resolve('/'));
	}

	async function handleJoin(): Promise<void> {
		failure = null;
		joining = true;
		let listId: string;
		try {
			listId = await joinList(token);
		} catch (e) {
			failure = refused(e) ? 'invalid' : 'join_failed';
			return;
		} finally {
			joining = false;
		}
		clearJoinToken();
		const url = resolve('/list/[id]', { id: listId });
		try {
			// In place of this screen: its token is gone from the URL, so going
			// back to it would only say the invitation is invalid.
			await goAcross(url);
		} catch {
			// The join is committed; a failed SPA navigation must not read as
			// a failed join, so load the list in full.
			window.location.replace(url);
		}
	}
</script>

<FocusScreen class="join">
	<!-- A visitor gets the language switch, as on the auth screen (§12.2):
	     settings is behind the account gate. -->
	<FocusTitle title={t('share_join_title')} locale={!$authState.isValid} />

	{#if loading}
		<Waiting />
	{:else if failure === 'invalid'}
		<ErrorText class="error" size="sm">{t('share_join_invalid')}</ErrorText>
		<!-- Not a dead end. A device with an account goes to its lists, and a
		     visitor goes to the sign-in. The dead token goes too. -->
		<Button type="button" onclick={leave}>
			{$authState.nickname !== null ? t('common_to_lists') : t('share_join_to_signin')}
		</Button>
	{:else if failure === 'preview_failed'}
		<ErrorText class="error" size="sm">{t('share_join_failed')}</ErrorText>
		<Button type="button" onclick={() => void loadPreview()}>{t('common_retry')}</Button>
	{:else if preview}
		<!-- The list as its card on the home will show it once joined. -->
		<div class={[cardSurface, 'preview flex flex-col gap-1.5 p-3.5']}>
			<p class="type-heading wrap-break-word hyphens-auto" dir="auto">
				{preview.name}
			</p>
			<Hint>
				{preview.items.length
					? t('share_join_items', { count: preview.items.length })
					: t('home_card_empty')}
				· {t('home_card_members', { count: preview.member_count })}
			</Hint>
			{#if previewNames}
				<p class="items text-sm text-foreground" dir="auto">{previewNames}</p>
			{/if}
		</div>

		{#if $authState.isValid}
			<Button type="button" disabled={joining} onclick={() => void handleJoin()}>
				{t('share_join_action')}
			</Button>
			{#if failure === 'join_failed'}
				<ErrorText class="error" size="sm">{t('share_join_failed')}</ErrorText>
			{/if}
		{:else if $authState.nickname !== null}
			<!-- Known device, expired session (§5.8, §12.1): AuthScreen here would
			     offer "create account" on a device that has one, minting a second
			     account and swapping the session underneath the first. -->
			<Hint size="sm">{t('share_join_session_expired')}</Hint>
			<ReauthButton />
		{:else}
			<p class="mx-0 mt-3 mb-0 text-sm text-foreground">{t('share_join_needs_account')}</p>
			<!-- The token lets a visitor in on an invite-only instance ([D-241]),
			     already on the list; the join then only opens it. -->
			<AuthScreen invite={token} onregistered={() => void handleJoin()} />
		{/if}
	{/if}
</FocusScreen>
