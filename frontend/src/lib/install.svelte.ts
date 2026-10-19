// Installing the app to the home screen ([D-231]).
//
// Chromium fires `beforeinstallprompt` once per page load, usually right after
// load, and holding that event is the only way to open its install dialog from
// a button; so the listener is registered at boot (+layout.svelte), not by the
// components that offer it. Safari and Firefox never fire it: there the app
// can only show the steps.
//
// Module state, because the app shell re-keys the banner and the settings card
// on a language change.

interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type InstallPlatform = 'ios' | 'android' | 'other';

export const install = $state({
	/** The captured `beforeinstallprompt`, while it is unspent. */
	deferred: null as BeforeInstallPromptEvent | null,
	/** Running from the home screen rather than in a browser tab. */
	standalone: false,
	/** `appinstalled` fired in this tab: the app is installed, this tab is not it. */
	installed: false
});

const STANDALONE = '(display-mode: standalone), (display-mode: fullscreen)';

function readStandalone(): boolean {
	// iOS Safari's own flag predates its display-mode media query support.
	const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return ios || (globalThis.matchMedia?.(STANDALONE).matches ?? false);
}

/** Registers the install listeners; returns their cleanup. Called once, at boot. */
export function listenForInstall(): () => void {
	install.standalone = readStandalone();

	function onBeforeInstallPrompt(event: Event): void {
		// Instead of the browser's own mini-infobar: our banner and card offer it.
		event.preventDefault();
		install.deferred = event as BeforeInstallPromptEvent;
	}
	function onInstalled(): void {
		install.deferred = null;
		install.installed = true;
	}
	const media = globalThis.matchMedia?.(STANDALONE) ?? null;
	function onDisplayMode(): void {
		install.standalone = readStandalone();
	}

	window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
	window.addEventListener('appinstalled', onInstalled);
	media?.addEventListener('change', onDisplayMode);
	return () => {
		window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
		window.removeEventListener('appinstalled', onInstalled);
		media?.removeEventListener('change', onDisplayMode);
	};
}

/**
 * Opens the browser's install dialog. The event can be used once — accepted
 * or dismissed, it is spent — so it is dropped before prompting.
 */
export async function promptInstall(): Promise<void> {
	const event = install.deferred;
	if (!event) return;
	install.deferred = null;
	await event.prompt();
	await event.userChoice;
}

/**
 * Which steps to show. Every browser on iOS adds to the home screen through
 * the share sheet (iOS 16.4+), so any iPhone is 'ios'; iPadOS asks for the
 * desktop site and reports itself as a Mac, which only its touch points give away.
 */
export function detectPlatform(userAgent: string, maxTouchPoints: number): InstallPlatform {
	if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
	if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'ios';
	if (/Android/.test(userAgent)) return 'android';
	return 'other';
}

export function currentPlatform(): InstallPlatform {
	return detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}
