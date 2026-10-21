// The ephemeral toasts over Sonner ([D-54]). An undo or a one-off message has
// one slot, newest wins (§9.1), so an older undo cannot linger and fire
// against stale state. A sync notice (§8.4, §8.3, §8.6) is never replaced
// before it was shown ([D-293]): notices queue beside that slot, one at a
// time, each for the full timeout.
import { toast } from 'svelte-sonner';
import { t } from '#lib/i18n/index.js';

/** §9.1's "few seconds": seven ([D-213]). */
export const TOAST_TIMEOUT_MS = 7000;

// The toast in showToast's slot.
let current: string | number | undefined;

/** Show a toast, replacing the one in this slot (§9.1 newest-wins). */
export function showToast(message: string, undo?: () => void | Promise<void>): void {
	if (current !== undefined) toast.dismiss(current);
	current = toast(message, {
		duration: TOAST_TIMEOUT_MS,
		action: undo
			? {
					label: t('common_undo'),
					onClick: () => void undo()
				}
			: undefined
	});
}

/** A failure of what the user asked for: showToast's slot, with the red
 *  icon, so it does not read as done ([D-332]). */
export function showFailure(message: string): void {
	if (current !== undefined) toast.dismiss(current);
	current = toast.error(message, { duration: TOAST_TIMEOUT_MS });
}

/** A change the device's database refused: it is lost unless the user hears of it. */
export function showSaveFailure(): void {
	showFailure(t('local_save_failed'));
}

const notices: string[] = [];
let noticeShown = false;

/** Show a sync notice once the ones before it have been shown ([D-293]). */
export function showNotice(message: string): void {
	notices.push(message);
	if (!noticeShown) nextNotice();
}

function nextNotice(): void {
	const message = notices.shift();
	noticeShown = message !== undefined;
	if (message === undefined) return;
	let done = false;
	const advance = () => {
		if (done) return;
		done = true;
		nextNotice();
	};
	toast(message, { duration: TOAST_TIMEOUT_MS, onDismiss: advance, onAutoClose: advance });
}
