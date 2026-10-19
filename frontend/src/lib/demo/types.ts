// The demo build's client half ([D-234]). The app imports `#demo`, never a
// file here: it resolves to on.ts only in the demo build (vite.config.ts) and to
// off.ts everywhere else. Both satisfy this type.
import type { Component } from 'svelte';

export interface Demo {
	/** This is the demo build. */
	enabled: boolean;
	/** The auth screen's content on a demo instance: what the demo is, and the button in. */
	Start: Component | null;
	/** The line above every signed-in screen saying when the data goes. */
	Banner: Component | null;
	/** Settings' sign-out in the demo: the account has no way back in, so it is deleted. */
	SignOut: Component | null;
}
