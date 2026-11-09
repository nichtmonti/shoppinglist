// What a list offers from its ⋮, in one order for both of its menus ([D-270]):
// the sheet inside the list and the home card's dropdown, which leaves out
// the categories. The menus hold what concerns the list as a whole
// ([D-271]); clearing the purchase dates is Frühere Artikel's, which runs it
// through ListActions too. Each menu renders its list of actions and hands the
// chosen id to ListActions.run; ListDialogs renders the sheets they open.
// Neither touches Dexie or PocketBase (mutations go through
// #lib/actions/lists.ts).
//
// The home has one ListActions, and so does a list route: its layout makes
// it and renders its dialogs, and the ⋮ sheet and Frühere Artikel take it
// from context (getListActions), so a sub-screen opens no second copy.
import { createContext, type Component } from 'svelte';
import { goForward } from '#lib/history-layers.svelte.js';
import { resolve } from '$app/paths';
import { t, type MessageKey } from '#lib/i18n/index.js';
import { AsyncDialog } from '#lib/state/async-action.svelte.js';
import { clearHistory, cloneList, exportList, leaveList, renameList } from '#lib/actions/lists.js';
import { showFailure, showToast } from '#lib/toasts.js';
import Tags from '@lucide/svelte/icons/tags';
import Users from '@lucide/svelte/icons/users';
import Pencil from '@lucide/svelte/icons/pencil';
import Copy from '@lucide/svelte/icons/copy';
import Download from '@lucide/svelte/icons/download';
import Eraser from '@lucide/svelte/icons/eraser';
import LogOut from '@lucide/svelte/icons/log-out';

export type ListActionId =
	'categories' | 'share' | 'rename' | 'clone' | 'export' | 'clear-history' | 'leave';

export interface ListAction {
	id: ListActionId;
	label: MessageKey;
	icon: Component;
	/** A server call outside the sync outbox (§7.5/§7.6/§9.3): unavailable
	 *  offline. Categories go through the outbox, export reads the local
	 *  mirror ([D-72]), and sharing shows what it can. */
	online: boolean;
	/** Opens something (a screen, a sheet, a prompt, a confirmation) rather
	 *  than acting at once: its row ends in ›. */
	opens: boolean;
}

const ACTIONS: Record<ListActionId, ListAction> = {
	categories: {
		id: 'categories',
		label: 'categories_edit',
		icon: Tags,
		online: false,
		opens: true
	},
	share: { id: 'share', label: 'home_action_share', icon: Users, online: false, opens: true },
	rename: { id: 'rename', label: 'home_action_rename', icon: Pencil, online: true, opens: true },
	clone: { id: 'clone', label: 'home_action_duplicate', icon: Copy, online: true, opens: true },
	export: {
		id: 'export',
		label: 'home_action_export',
		icon: Download,
		online: false,
		opens: false
	},
	'clear-history': {
		id: 'clear-history',
		label: 'home_action_clear_history',
		icon: Eraser,
		online: true,
		opens: true
	},
	leave: { id: 'leave', label: 'home_action_leave', icon: LogOut, online: true, opens: true }
};

/** The one action that takes the list away: last, and red. */
export const LEAVE_ACTION = ACTIONS.leave;

/** Frühere Artikel's, where the dates it forgets are shown ([D-271]). */
export const CLEAR_HISTORY_ACTION = ACTIONS['clear-history'];

/** The ⋮ inside a list. */
export const LIST_ACTIONS: readonly ListAction[] = [
	ACTIONS.categories,
	ACTIONS.share,
	ACTIONS.rename,
	ACTIONS.clone,
	ACTIONS.export,
	LEAVE_ACTION
];

/** The home card's ⋮: the same but the categories, which are edited from
 *  inside the list ([D-271]). */
export const HOME_ACTIONS: readonly ListAction[] = LIST_ACTIONS.filter(
	(a) => a !== ACTIONS.categories
);

// The sheets; AsyncDialog closes one only on success, so a failure shows in
// the sheet the user is still looking at.
export type ListDialog =
	| { kind: 'rename'; listId: string; current: string }
	| { kind: 'clone'; listId: string; name: string }
	| { kind: 'leave'; listId: string; name: string }
	| { kind: 'clear-history'; listId: string; name: string };

export class ListActions {
	readonly dialog = new AsyncDialog<ListDialog>({ onClose: 'forget' });
	/** The list whose share sheet is open, or null. */
	shareFor = $state<string | null>(null);
	#isOnline: () => boolean;
	#afterLeave: () => Promise<void> | void;

	/** `afterLeave` runs once a leave went through: inside the list, the way
	 *  home. */
	constructor(isOnline: () => boolean, afterLeave: () => Promise<void> | void = () => {}) {
		this.#isOnline = isOnline;
		this.#afterLeave = afterLeave;
	}

	/** Whether a server-only action can run now; its control is greyed out otherwise. */
	available = (id: ListActionId): boolean => !ACTIONS[id].online || this.#isOnline();

	run = (id: ListActionId, listId: string, name: string): void => {
		if (!this.available(id)) return;
		switch (id) {
			case 'categories':
				void goForward(resolve('/list/[id]/categories', { id: listId }));
				break;
			case 'share':
				this.shareFor = listId;
				break;
			case 'rename':
				this.dialog.open({ kind: 'rename', listId, current: name });
				break;
			case 'clone':
				this.dialog.open({ kind: 'clone', listId, name });
				break;
			case 'export':
				this.#exportBackup(listId);
				break;
			case 'clear-history':
				this.dialog.open({ kind: 'clear-history', listId, name });
				break;
			case 'leave':
				this.dialog.open({ kind: 'leave', listId, name });
				break;
		}
	};

	submitRename = async (listId: string, name: string): Promise<void> => {
		await this.dialog.run(() => renameList(listId, name));
	};

	submitClone = async (listId: string, name: string): Promise<void> => {
		const attempt = await this.dialog.run(() => cloneList(listId, name));
		if (attempt.ok) await goForward(resolve('/list/[id]', { id: attempt.value }));
	};

	// A dismissed share sheet (`false`) gets no toast.
	#exportBackup(listId: string): void {
		exportList(listId)
			.then((delivered) => {
				if (delivered) showToast(t('home_export_done'));
			})
			.catch(() => showFailure(t('home_export_failed')));
	}

	submitLeave = async (listId: string): Promise<void> => {
		if ((await this.dialog.run(() => leaveList(listId))).ok) await this.#afterLeave();
	};

	// [D-79]: non-destructive, so its confirm sheet is the default variant.
	submitClearHistory = async (listId: string): Promise<void> => {
		const attempt = await this.dialog.run(() => clearHistory(listId));
		if (attempt.ok) showToast(t('history_cleared', { count: attempt.value }));
	};
}

/** The list route's ListActions, set by its layout ([D-270]). */
export const [getListActions, setListActions] = createContext<ListActions>();
