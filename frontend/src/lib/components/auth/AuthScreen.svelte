<!--
  The sign-in / create-account screen (§5.4, §5.9): the app shell's gate, so
  everything below it can assume an account (§7.6).

  Sign-in comes first, as a self-contained button: credentials are
  discoverable, so no username is involved. The nickname field in the
  create-account half doubles as the anchor for the conditional ("autofill")
  login ceremony, a second way for a returning visitor to find their passkey.
  Both matter because the server cannot tell a duplicate signup from a genuine
  one: a returning visitor who picks "create account" mints a second account.

  Inside the join screen (`invite`, [D-265]) it is that page's account step:
  no title, language switch or passkey intro of its own, and the new account
  comes first, where the nickname field's autofill still offers a returning
  visitor's passkey.

  On an invite-only instance ([D-241]) creating an account needs a link:
  `invite` from JoinScreen, or the setup link from the server's log
  (#lib/auth/setup-link).
-->
<script lang="ts">
	import Waiting from '#lib/components/common/Waiting.svelte';
	import Hint from '#lib/components/common/Hint.svelte';
	import { onMount, tick } from 'svelte';
	import {
		canUsePasskeyAutofill,
		canUsePasskeys,
		cancelConditionalLogin,
		clearSetupToken,
		fetchAuthMethods,
		isAutofillUnsupported,
		isCeremonyDismissal,
		login,
		oidcLogin,
		register,
		setupToken,
		type AuthMethods,
		type SignupLink
	} from '#lib/auth/index.js';
	import { oidcProvider as providerOf, passkeySignup } from '#lib/auth/login-methods.js';
	import { AsyncAction, failureMessage } from '#lib/state/async-action.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Field, FieldLabel } from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { maxBytesFor } from '#lib/field-contract.js';
	import FocusScreen from '#lib/components/common/FocusScreen.svelte';
	import FocusTitle from '#lib/components/common/FocusTitle.svelte';
	import ErrorText from '#lib/components/common/ErrorText.svelte';
	import OidcButton from './OidcButton.svelte';
	import { demo } from '#demo';

	// [D-234] The demo build's way in; null in every other build.
	const DemoStart = demo.Start;

	let {
		invite,
		onregistered
	}: {
		/** A list's invite token: on an invite-only instance, the way in ([D-241]). */
		invite?: string;
		/** Called once a new account exists (JoinScreen then joins the list). */
		onregistered?: () => void;
	} = $props();

	// The link a new account comes in by ([D-241]), if this visitor has one.
	const setup = setupToken();
	let link = $derived<SignupLink | undefined>(invite ? { invite } : setup ? { setup } : undefined);
	// On the join screen ([D-265]), which holds the page's title and language
	// switch: this is its account step, and a visitor holding an invite is most
	// likely new.
	let joining = $derived(!!invite);

	let nickname = $state('');

	// Create pressed with no nickname: the field says so and takes focus.
	let nicknameInput = $state<HTMLInputElement | null>(null);
	let triedWithoutNickname = $state(false);
	let nicknameMissing = $derived(triedWithoutNickname && !nickname.trim());
	function createAccount(): void {
		const name = nickname.trim();
		if (!name) {
			triedWithoutNickname = true;
			nicknameInput?.focus();
			return;
		}
		void action.run(async () => {
			await register(name, link);
			clearSetupToken();
			onregistered?.();
		});
	}

	// #lib/auth throws localized ceremony errors, so show their message.
	const action = new AsyncAction();

	// A failure of the background conditional ceremony after the user picked
	// a credential (see startConditionalLogin).
	let bgError = $state<string | null>(null);
	// Which logins this instance offers ([D-76]), fetched on every mount and
	// waited for: a stale or guessed answer would offer a button that does not
	// work here.
	let methods = $state<AuthMethods | null>(null);
	let methodsFailed = $state(false);
	let passkeysUsable = $derived(!!methods?.passkeys.enabled && canUsePasskeys());
	let signup = $derived(methods && passkeysUsable ? passkeySignup(methods, !!link) : 'closed');
	let signupOpen = $derived(signup === 'open');
	// Invite-only and no link in hand: say how to get one ([D-241]).
	let signupNeedsLink = $derived(signup === 'link');
	let oidcProvider = $derived(methods ? providerOf(methods) : undefined);
	let oidcName = $derived(methods?.oidc.name ?? oidcProvider ?? '');
	// Which screen the methods leave, past the passkey doors.
	let demoOnly = $derived(!!methods && !!DemoStart && !methods.passkeys.enabled && !oidcProvider);
	let oidcOnly = $derived(!!methods && !!oidcProvider && !methods.passkeys.enabled);
	let unsupported = $derived(!!methods && !passkeysUsable && !demoOnly && !oidcOnly);

	async function loadMethods(): Promise<void> {
		methodsFailed = false;
		const answer = await fetchAuthMethods();
		if (!answer) {
			methodsFailed = true;
			return;
		}
		methods = answer;
		// The autofill anchor is the create-account nickname field, so the
		// conditional ceremony needs that half on screen — rendered by now.
		if (signupOpen) {
			await tick();
			startConditionalLogin();
		}
	}
	onMount(() => {
		void loadMethods();
		// A sign-in another way (OIDC, the demo) leaves the screen with the
		// autofill offer still pending.
		return cancelConditionalLogin;
	});

	// The provider popup is open (OidcButton then offers "Abbrechen").
	let oidcPending = $state(false);
	async function startOidc(): Promise<void> {
		const provider = oidcProvider;
		if (!provider) return;
		// No await before oidcLogin: it opens the popup synchronously, on this
		// click's user activation.
		oidcPending = true;
		await action.run(() => oidcLogin(provider));
		oidcPending = false;
	}
	/**
	 * Start the background conditional-mediation ceremony. Not run through
	 * `action`: it stays pending until the user picks a credential, and `busy`
	 * would disable both buttons for the life of the screen. A dismissal or
	 * abort (a button starting its own ceremony cancels this one) is the normal
	 * path and stays silent, as does a browser refusing the autofill it
	 * claimed (pressing the sign-in button reports that); anything else happened after the
	 * user engaged and goes to `bgError`, or it would read as a dead button.
	 */
	function startConditionalLogin(): void {
		void (async () => {
			// Its own try: a throw here would be an unhandled rejection, and it
			// stays silent because the user has not engaged yet.
			try {
				if (!(await canUsePasskeyAutofill())) return;
			} catch {
				return;
			}
			try {
				await login({ conditional: true });
			} catch (e) {
				if (isCeremonyDismissal(e) || isAutofillUnsupported(e)) return;
				bgError = failureMessage(e);
			}
		})();
	}
</script>

<svelte:head>
	<title>{t('common_app_name')}</title>
</svelte:head>

<!-- On the join screen these are the join's own blocks; alone, a focus
     screen ([D-323]). -->
{#if joining}
	<div class="flex flex-col gap-3">{@render screen()}</div>
{:else}
	<FocusScreen>{@render screen()}</FocusScreen>
{/if}

{#snippet screen()}
	<!-- §12.2: settings is behind the gate, so someone who cannot read this
	     screen needs its language switch here. On the join screen, which has
	     its own title, only a browser that cannot sign in says so. -->
	{#if !joining && !demoOnly}
		<FocusTitle title={unsupported ? t('auth_no_passkey_support') : t('auth_title')} locale />
	{:else if joining && unsupported}
		<h2 class="type-heading">{t('auth_no_passkey_support')}</h2>
	{/if}
	{#if !methods}
		{#if methodsFailed}
			<ErrorText size="sm">{t('auth_methods_failed')}</ErrorText>
			<Button onclick={() => void loadMethods()}>
				{t('common_retry')}
			</Button>
		{:else}
			<Waiting title={t('auth_methods_loading')} />
		{/if}
	{:else if passkeysUsable}
		{#if !joining}
			<Hint size="sm">{t('auth_intro')}</Hint>
		{/if}
		<!-- Two doors, each with its own heading, so a first-time visitor can
		     tell which one is theirs before pressing anything. The one this
		     screen expects comes first and is the filled button: sign-in here
		     ([D-69]), a new account for a visitor holding an invite ([D-265]). -->
		{#if joining}
			{@render signupDoor(false)}
			{@render signinDoor(true)}
		{:else}
			{@render signinDoor(false)}
			{@render signupDoor(true)}
		{/if}
	{:else if demoOnly && DemoStart}
		<!-- [D-234] A demo instance has no other login. -->
		<DemoStart />
	{:else if oidcOnly}
		<!-- [D-76]: an OIDC-only instance; the first sign-in creates the account. -->
		<Hint size="sm">{t('auth_intro_oidc', { name: oidcName })}</Hint>
		{@render oidcButton(oidcName)}
	{:else}
		<Hint size="sm">{t('auth_no_passkey_support_body')}</Hint>
		<!-- With OIDC on (§5.9 [D-76]), a browser without WebAuthn can still sign in. -->
		{#if oidcProvider}
			<div class="mt-3 flex flex-col">{@render oidcButton(oidcName)}</div>
		{/if}
	{/if}
	{#if action.error ?? bgError}
		<ErrorText size="sm">{action.error ?? bgError}</ErrorText>
	{/if}
{/snippet}

{#snippet oidcButton(name: string)}
	<OidcButton pending={oidcPending} disabled={action.busy} onstart={() => void startOidc()}>
		{t('auth_oidc_login', { name })}
	</OidcButton>
{/snippet}

<!-- `below`: the second door, under a rule and outlined, a step below the
     first. -->
{#snippet signinDoor(below: boolean)}
	<section
		aria-labelledby={signupOpen || signupNeedsLink ? 'auth-signin-heading' : undefined}
		class={['mt-4 flex flex-col gap-2.5', below && 'border-t border-border pt-4']}
	>
		{#if signupOpen || signupNeedsLink}
			<!-- On the join screen, someone who already uses the installed app reads
			     this: iOS opens the link in Safari, which does not know them, and
			     their passkey signs them in here too ([D-297]). -->
			<h2 id="auth-signin-heading" class="type-heading">
				{joining ? t('auth_signin_heading_join') : t('auth_signin_heading')}
			</h2>
			{#if joining}
				<Hint size="sm">{t('auth_signin_body_join')}</Hint>
			{/if}
		{/if}
		<Button
			variant={below ? 'outline' : 'default'}
			onclick={() => void action.run(() => login())}
			disabled={action.busy}
		>
			{t('auth_login')}
		</Button>
		<!-- §5.9 [D-76]: the instance's OIDC login, when switched on. -->
		{#if oidcProvider}
			{@render oidcButton(oidcName)}
		{/if}
	</section>
{/snippet}

<!-- [D-76] [D-241]: the create-account half only while signup is open or
     this visitor holds the link, or the server would refuse with a 403 after
     the visitor had typed a nickname and run a ceremony. -->
{#snippet signupDoor(below: boolean)}
	{#if signupNeedsLink || signupOpen}
		<section
			aria-labelledby="auth-signup-heading"
			class={['mt-4 flex flex-col gap-2.5', below && 'border-t border-border pt-4']}
		>
			<h2 id="auth-signup-heading" class="type-heading">{t('auth_signup_heading')}</h2>
			{#if signupNeedsLink}
				<Hint size="sm">{t('auth_signup_by_link')}</Hint>
			{:else}
				<Hint size="sm">{t('auth_signup_body')}</Hint>
				<!-- 16px floor: iOS Safari auto-zooms on focus below 16px. -->
				<Field class="mt-1" error={nicknameMissing ? t('auth_nickname_required') : undefined}>
					<FieldLabel for="auth-nickname">{t('auth_nickname_label')}</FieldLabel>
					<!-- Conditional mediation binds to `autocomplete="username webauthn"`
					     ("webauthn" last), and @simplewebauthn refuses to start without
					     such an input in the DOM. -->
					<Input
						id="auth-nickname"
						bind:ref={nicknameInput}
						bind:value={nickname}
						maxlength={maxBytesFor('accounts', 'nickname')}
						placeholder={t('auth_nickname_placeholder')}
						autocomplete="username webauthn"
						enterkeyhint="done"
					/>
				</Field>
				<!-- Never disabled for a missing nickname: a disabled button cannot
				     say what it waits for, so pressed early it says so under the
				     field. -->
				<Button
					variant={below ? 'outline' : 'default'}
					onclick={createAccount}
					disabled={action.busy}
				>
					{joining ? t('auth_create_account_join') : t('auth_create_account')}
				</Button>
			{/if}
		</section>
	{/if}
{/snippet}
