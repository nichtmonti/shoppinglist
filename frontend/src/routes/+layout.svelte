<!--
  The app shell: boots the session (§5.6), the locale (§12.2) and the
  suggestion-suppression mirror (§6.11); gates on an account (§7.6: no
  anonymous editing); mounts the sync engine while the session is valid.

  The gate keys off `authState.nickname`, not `isValid`: an expired token gates
  syncing only (§5.8), so a device that ever signed in keeps the real app, with
  the SyncBanner's re-auth (§12.1). Only logout() clears `nickname`.

  The engine is mounted here, once per tab, because `startSyncLoop()` runs
  under Web-Locks leadership (§8.7). Per-list SSE follows navigation, in the
  list route.

  `/join` is exempt from the gate: the invite preview is unauthenticated by
  design (§7.6), and JoinScreen embeds AuthScreen itself.
-->
<script lang="ts">
	import '@fontsource-variable/readex-pro';
	import '../app.css';
	import { ModeWatcher, userPrefersMode } from 'mode-watcher';
	import { followThemeChoice } from '#lib/theme-color.js';
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { dev } from '$app/env';
	import { authState, refreshOnStart } from '#lib/auth/index.js';
	import { listView, loadLocale, localePref, uiDensity } from '#lib/state/prefs.js';
	import { mountSync, unmountSync } from '#lib/sync/index.js';
	import { noticeToasts } from '#lib/state/sync-notices.js';
	import { requestPersistentStorage } from '#lib/storage.js';
	import { getLocale, setLocale } from '#lib/i18n/index.js';
	import { goAcross, recordLinkOrigins } from '#lib/history-layers.svelte.js';
	import ErrorView from '#lib/components/common/ErrorView.svelte';
	import { describeError, reportClientError } from '#lib/client-errors.js';
	import { listenForInstall } from '#lib/install.svelte.js';
	import { demo } from '#demo';

	// [D-234] The demo's standing notice; null in every other build.
	const DemoBanner = demo.Banner;

	let { children } = $props();

	// Off the boot path ([D-203]), loaded when first needed: the hidden
	// suggestions' sync, the sign-in screen (signed-out devices only) and the
	// toast host. The first frame waits on none of them.
	const suppression = () => import('#lib/state/suppression.js');

	// A screen that throws after it loaded never reaches +error.svelte; without
	// the boundary below it leaves an empty page.
	function reportRenderError(error: unknown): void {
		const { message, stack } = describeError(error);
		reportClientError({
			message,
			stack,
			route: page.route.id ?? '',
			path: page.url.pathname,
			status: 500,
			context: 'render'
		});
	}

	let booted = $state(false);
	// Nothing renders before `setLocale()` has applied, so the first frame is
	// not in the base locale for a moment. Separate from `booted`, which also
	// waits on the network, so a signed-in device renders after one local read.
	let localeLoaded = $state(false);
	// /dev/* is the design gallery: fixtures only, no account needed. `dev` is
	// a build-time constant, so a production bundle drops it.
	let publicRoute = $derived(
		page.url.pathname.startsWith('/join') || (dev && page.url.pathname.startsWith('/dev'))
	);

	onMount(() => {
		// Mobile Safari applies `:active` to non-anchors only when the document
		// has a touch listener; without it the tile press-scale does nothing on
		// an iPhone. Empty on purpose.
		document.addEventListener('touchstart', () => {}, { passive: true });

		// §6.11 [D-137]: a suggestion hidden or restored offline is delivered when
		// the connection comes back, not only at the next app start.
		const onOnline = () => void suppression().then(({ flushSuppressed }) => flushSuppressed());
		window.addEventListener('online', onOnline);

		// Read the list-view pref from boot, so opening a list from the home
		// finds it already answered rather than waiting a frame on it ([D-196]).
		const unsubscribeView = listView.subscribe(() => {});

		// Chromium offers installation once per page load, usually right away ([D-231]).
		const stopInstall = listenForInstall();

		// Best-effort and independent of the rest of boot (§8.8) — never gates `booted`.
		void requestPersistentStorage();
		// [D-76]: which logins the instance offers; a failure keeps the last answer.
		void import('#lib/state/auth-methods.js').then(({ refreshAuthMethods }) =>
			refreshAuthMethods()
		);
		void (async () => {
			await loadLocale();
			localeLoaded = true;
			await refreshOnStart();
			// A failure leaves the app offline (§5.8); not an unhandled rejection.
			await suppression()
				.then(({ refreshSuppressedMirror }) => refreshSuppressedMirror())
				.catch(() => {});
			booted = true;
			// [D-202] Every screen's code, after the first screen has painted.
			requestAnimationFrame(() =>
				setTimeout(
					() =>
						void import('#lib/route-preload.js')
							.then(({ preloadScreens }) => preloadScreens())
							.catch(() => {})
				)
			);
		})();
		return () => {
			window.removeEventListener('online', onOnline);
			unsubscribeView();
			stopInstall();
		};
	});

	// Every tab follows the stored language ([D-291]): a switch in another tab
	// arrives here through Dexie's cross-tab liveQuery, and the strings change
	// in place.
	const localePrefLoaded = localePref.loaded;
	$effect(() => {
		if ($localePrefLoaded) setLocale($localePref);
	});

	// `app.html` hardcodes lang="en"; screen readers and hyphenation follow this.
	$effect(() => {
		document.documentElement.lang = getLocale();
	});

	// §9.1 [D-83]: the density tokens live on the ROOT so vaul-portaled sheets
	// (rendered to <body>, outside .app-shell) follow too.
	$effect(() => {
		document.documentElement.dataset.density = $uiDensity;
	});

	// The browser bar follows the app's light/dark choice, not only the phone's.
	$effect(() => followThemeChoice(userPrefersMode.current));

	// The engine follows the session, not the route. `mountSync` is idempotent, so
	// re-running this effect (e.g. on a token refresh) cannot start a second loop.
	$effect(() => {
		if ($authState.isValid) mountSync(noticeToasts);
		else unmountSync();
	});

	// The in-app ‹ buttons go BACK to the screen a link came from ([D-230]).
	recordLinkOrigins();

	// A sign-out lands on the home route ([D-185]), so the next sign-in does
	// not reopen /settings. Navigating on the way out, not after sign-in, keeps
	// a cold visit to a list's link signing straight into that list. An expired
	// session keeps `nickname`, so re-auth stays where it is.
	let wasSignedIn = false;
	$effect(() => {
		const signedIn = $authState.nickname !== null;
		if (wasSignedIn && !signedIn && !publicRoute && page.url.pathname !== '/') {
			// Through the history queue ([D-230]): the closing confirmation's back
			// would otherwise land after this and restore the route.
			void goAcross(resolve('/'));
		}
		wasSignedIn = signedIn;
	});

	// A session that starts after boot (a sign-in on a new device, a re-auth
	// after an expired session) mirrors the account's hidden suggestions, as
	// boot does: without them every hidden name is offered, and adding one
	// would not unhide it (§6.11). The refresh then delivers what a 401 held
	// ([D-137]).
	$effect(() => {
		if ($authState.isValid)
			void suppression()
				.then(({ refreshSuppressedMirror }) => refreshSuppressedMirror())
				.catch(() => {});
	});

	onDestroy(() => unmountSync());
</script>

<div class="app-shell" data-testid="app-shell">
	<ModeWatcher />
	{#if DemoBanner && localeLoaded && $authState.nickname !== null}<DemoBanner />{/if}
	{#if localeLoaded && ($authState.nickname !== null || (publicRoute && booted))}
		<svelte:boundary onerror={reportRenderError}>
			{@render children()}
			{#snippet failed(error, reset)}
				<ErrorView detail={describeError(error).message} {reset} />
			{/snippet}
		</svelte:boundary>
	{:else if booted}
		{#await import('#lib/components/auth/AuthScreen.svelte') then { default: AuthScreen }}
			<AuthScreen />
		{/await}
	{/if}
</div>

{#await import('#lib/components/ui/sonner/index.js') then { Toaster }}
	<Toaster position="bottom-center" />
{/await}
