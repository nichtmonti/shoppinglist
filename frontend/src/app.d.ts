// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// SvelteKit's own `status` and `message`, plus `detail`: the thrown
		// error's one-line description, set by hooks.client.ts for the error
		// page ([D-197]).
		interface Error {
			detail?: string;
			// A retry of the failed route is already scheduled ([D-202]).
			retrying?: boolean;
		}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			// The app's history entries (#lib/history-layers).
			/** The screen that opened this one, when it was this app. */
			from?: string;
			/** A screen's temporary mode, as a shallow entry. */
			mode?: import('#lib/history-layers.svelte.js').HistoryMode;
			/** The open overlays (sheets, dialogs, menus), bottom first, one shallow entry each. */
			overlays?: string[];
		}
		// interface Platform {}
	}
}

export {};
