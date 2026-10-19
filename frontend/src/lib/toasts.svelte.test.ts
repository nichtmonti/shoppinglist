// The undo / restore toast: §9.1 is explicit that "no destructive action is
// left without a one-tap safety net". The toast surface is Sonner ([D-54]), so
// toasts.ts is a thin adapter over svelte-sonner.
//
// This test exercises the adapter's contract directly: it must dismiss ALL
// existing toasts before showing a new one (the §9.1 newest-wins wrapper — an
// older undo must not linger and fire against stale state), pass the message
// and the §9.1 timeout through, and wire the localized undo label to the
// callback. Sonner itself is mocked; the real rendering is covered by the
// svelte-sonner package's own tests.
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { showFailure, showNotice, showToast, TOAST_TIMEOUT_MS } from './toasts';

// The adapter calls `toast.dismiss()` (dismiss-all) then `toast(message, opts)`.
type SonnerToast = ReturnType<typeof vi.fn> & {
	dismiss: ReturnType<typeof vi.fn>;
	success: ReturnType<typeof vi.fn>;
	error: ReturnType<typeof vi.fn>;
	info: ReturnType<typeof vi.fn>;
	warning: ReturnType<typeof vi.fn>;
	loading: ReturnType<typeof vi.fn>;
	message: ReturnType<typeof vi.fn>;
	promise: ReturnType<typeof vi.fn>;
	custom: ReturnType<typeof vi.fn>;
};

const { toastMock } = vi.hoisted(() => {
	const toastMock = vi.fn() as unknown as SonnerToast;
	toastMock.dismiss = vi.fn();
	toastMock.success = vi.fn();
	toastMock.error = vi.fn();
	toastMock.info = vi.fn();
	toastMock.warning = vi.fn();
	toastMock.loading = vi.fn();
	toastMock.message = vi.fn();
	toastMock.promise = vi.fn();
	toastMock.custom = vi.fn();
	return { toastMock };
});

vi.mock('svelte-sonner', () => ({
	toast: toastMock,
	Toaster: () => null
}));

beforeEach(() => {
	toastMock.mockClear();
	toastMock.dismiss.mockClear();
});

describe('toast adapter over sonner', () => {
	it('shows the message with the §9.1 timeout and no undo', () => {
		showToast('first');

		expect(toastMock).toHaveBeenCalledWith('first', {
			duration: TOAST_TIMEOUT_MS,
			action: undefined
		});
	});

	it('passes the §9.1 timeout as the duration', () => {
		showToast('x');
		expect(toastMock).toHaveBeenCalledWith(
			'x',
			expect.objectContaining({ duration: TOAST_TIMEOUT_MS })
		);
	});

	it('wires a localized undo action whose onClick invokes the callback', () => {
		const undone = vi.fn();
		showToast('„Milch" abgehakt', undone);

		const [, opts] = toastMock.mock.calls[0];
		expect(opts.action).toBeDefined();
		// test-kit/component-setup resets the locale to 'de', so common_undo is "Rückgängig".
		expect(opts.action.label).toBe('Rückgängig');

		opts.action.onClick();
		expect(undone).toHaveBeenCalledTimes(1);
	});

	it('carries no undo affordance for a non-reversible notice', () => {
		showToast('Anna hatte die Menge schon auf 3 gesetzt');
		const [, opts] = toastMock.mock.calls[0];
		expect(opts.action).toBeUndefined();
	});

	it('newest wins: a second showToast dismisses the first before showing', () => {
		toastMock.mockReturnValueOnce('id-1').mockReturnValueOnce('id-2');
		showToast('first');
		showToast('second');

		expect(toastMock.dismiss).toHaveBeenCalledWith('id-1');
		expect(toastMock).toHaveBeenNthCalledWith(1, 'first', expect.anything());
		expect(toastMock).toHaveBeenNthCalledWith(2, 'second', expect.anything());
	});

	// [D-332] A failure carries the red icon (Sonner's error toast), in the
	// same newest-wins slot, so an old undo cannot outlive it.
	it('shows a failure as an error toast in the same slot', () => {
		toastMock.mockReturnValueOnce('undo-1');
		toastMock.error.mockReturnValueOnce('fail-1');
		showToast('„Milch“ abgehakt', () => {});
		showFailure('Export fehlgeschlagen');

		expect(toastMock.dismiss).toHaveBeenCalledWith('undo-1');
		expect(toastMock.error).toHaveBeenCalledWith('Export fehlgeschlagen', {
			duration: TOAST_TIMEOUT_MS
		});
		showToast('next');
		expect(toastMock.dismiss).toHaveBeenCalledWith('fail-1');
	});
});

// [D-293] §8.4: a lost edit is never silent, so a notice is not replaced
// before it was shown, by the next notice or by an undo.
describe('sync notices', () => {
	type Opts = { onDismiss: () => void; onAutoClose: () => void };
	const shown = () => toastMock.mock.calls.map(([message]) => message as string);
	const optsOf = (message: string) => toastMock.mock.calls.find(([m]) => m === message)![1] as Opts;

	it('shows notices one after another, each until it closes', () => {
		showNotice('Anna hatte die Menge schon auf „3“ gesetzt');
		showNotice('„Brot“ wurde entfernt, während du es bearbeitet hast');
		expect(shown()).toEqual(['Anna hatte die Menge schon auf „3“ gesetzt']);

		optsOf('Anna hatte die Menge schon auf „3“ gesetzt').onAutoClose();
		expect(shown()).toEqual([
			'Anna hatte die Menge schon auf „3“ gesetzt',
			'„Brot“ wurde entfernt, während du es bearbeitet hast'
		]);
		// Closing twice (dismissed, then the timer) advances once.
		optsOf('Anna hatte die Menge schon auf „3“ gesetzt').onDismiss();
		expect(shown()).toHaveLength(2);
		optsOf('„Brot“ wurde entfernt, während du es bearbeitet hast').onDismiss();
	});

	it('is not dismissed by an undo toast', () => {
		toastMock.mockReturnValueOnce('notice-1').mockReturnValueOnce('undo-1');
		showNotice('Anna hatte die Menge schon auf „3“ gesetzt');
		showToast('„Milch“ abgehakt', () => {});

		expect(toastMock.dismiss).not.toHaveBeenCalledWith('notice-1');
		optsOf('Anna hatte die Menge schon auf „3“ gesetzt').onAutoClose();
	});
});
