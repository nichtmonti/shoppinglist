// The home's own actions (§9.3): create, join and import. A card's ⋮ actions
// are ListActions' ([D-270]). ListsHome owns one of these and hands it to
// HomeDialogs, which renders the sheets it opens; neither touches Dexie or
// PocketBase (mutations go through #lib/actions/lists.ts).
import { goForward } from '#lib/history-layers.svelte.js';
import { resolve } from '$app/paths';
import { AsyncDialog } from '#lib/state/async-action.svelte.js';
import { createList } from '#lib/actions/lists.js';
import { tokenFromInput } from '#lib/actions/invites.js';

// The home's sheets; AsyncDialog closes one only on success, so a failure
// shows in the sheet the user is still looking at.
export type HomeDialog = { kind: 'create' } | { kind: 'join' };

export class HomeActions {
	readonly dialog = new AsyncDialog<HomeDialog>({ onClose: 'forget' });
	#isOnline: () => boolean;

	constructor(isOnline: () => boolean) {
		this.#isOnline = isOnline;
	}

	// Create and join are online-only (§7.5/§7.6/§9.3): server calls outside
	// the sync outbox.
	create = (): void => {
		if (this.#isOnline()) this.dialog.open({ kind: 'create' });
	};

	submitCreate = async (name: string): Promise<void> => {
		const attempt = await this.dialog.run(() => createList(name));
		if (attempt.ok) await goForward(resolve('/list/[id]', { id: attempt.value }));
	};

	join = (): void => {
		if (this.#isOnline()) this.dialog.open({ kind: 'join' });
	};

	// Only extracts the token and navigates; the join screen validates it
	// against the server, as for a tapped invite link (§7.1: the token lives
	// in the fragment). A location assignment rather than `goto()`: the
	// fragment must be there on first paint, and the lint rule
	// `svelte/no-navigation-without-resolve` lets no fragment through `goto()`.
	submitJoin = (input: string): void => {
		const token = tokenFromInput(input);
		// The join screen takes the dialog's history entry, so back from it is
		// the home with no dead step between. Not back over the entry and then
		// a new one: Firefox made that load replace the home's entry instead.
		window.location.replace(`${resolve('/join')}#${token}`);
	};

	// [D-254] Import is its own screen: a pasted or shared text list, or a
	// backup file. Not online-only any more: text into an existing list goes
	// through the outbox, and the screen disables what needs the server.
	openImport = (): void => {
		void goForward(resolve('/import'));
	};
}
