import { addFocusRequested } from '#lib/state/add-focus.js';
import { listView } from '#lib/state/prefs.js';

/**
 * Hand off to adding an item: switch to the list view, whose add bar takes
 * focus on arrival. The flag is module-level, so it survives a navigation the
 * caller makes afterwards.
 */
export function startAdding(): void {
	addFocusRequested.set(true);
	void listView.set('list');
}
