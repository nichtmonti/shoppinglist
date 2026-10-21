// #lib/state/async-action — the mutation state machine every online-only
// transactional surface runs on. Named *.svelte.test.ts so it lands in the
// `client` vitest project: the module under test declares `$state` class fields,
// which need Svelte's browser build.
import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/client-errors.js', () => ({ reportUncaught: vi.fn() }));
import { reportUncaught } from '#lib/client-errors.js';
import { t } from '#lib/i18n/index.js';
import { AsyncAction, AsyncDialog, failureMessage } from './async-action.svelte';
import { LocalizedError } from '#lib/localized-error.js';

/** Compared against the real message rather than a hardcoded string, so a
 *  reworded catalog entry does not read as a broken state machine. */
const GENERIC = () => t('common_error');

describe('AsyncAction', () => {
	it('holds busy for the duration and returns the value', async () => {
		const action = new AsyncAction();
		let resolveFn: (v: string) => void = () => {};
		const pending = action.run(() => new Promise<string>((r) => (resolveFn = r)));

		expect(action.busy).toBe(true);
		resolveFn('list-1');
		expect(await pending).toEqual({ ok: true, value: 'list-1' });
		expect(action.busy).toBe(false);
		expect(action.error).toBeUndefined();
	});

	it('maps a rejection onto error and never rethrows', async () => {
		const action = new AsyncAction();
		// The point of the whole class: an escaping rejection here would be an
		// unhandled rejection, which is the bug the list layout's rename had.
		await expect(action.run(() => Promise.reject(new Error('boom')))).resolves.toEqual({
			ok: false
		});
		expect(action.busy).toBe(false);
		expect(action.error).toBe(GENERIC());
	});

	it('clears a previous error when the next attempt starts', async () => {
		const action = new AsyncAction();
		await action.run(() => Promise.reject(new Error('boom')));
		expect(action.error).toBeDefined();

		const pending = action.run(() => Promise.resolve(1));
		expect(action.error).toBeUndefined();
		await pending;
	});

	it("never shows a plain Error's message: the app's own copy is a LocalizedError", async () => {
		const generic = new AsyncAction();
		await generic.run(() => Promise.reject(new Error('this passkey is already registered')));
		expect(generic.error).toBe(GENERIC());
	});

	// [D-197] What the screen says only as "Something went wrong" reaches the
	// server log; a server's answer and the app's own copy do not.
	it("reports the app's own error, not a server's answer or user copy", async () => {
		vi.mocked(reportUncaught).mockClear();
		const action = new AsyncAction();
		const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
		await action.run(() => Promise.reject(bug));
		await action.run(() => Promise.reject(Object.assign(new Error('x'), { status: 500 })));
		await action.run(() => Promise.reject(new LocalizedError('Du bist schon auf 25 Listen')));
		expect(vi.mocked(reportUncaught).mock.calls).toEqual([[bug, 'action']]);
	});

	it('always surfaces a LocalizedError — it is user copy, not noise ([D-219])', async () => {
		const generic = new AsyncAction();
		await generic.run(() => Promise.reject(new LocalizedError('Du bist schon auf 25 Listen')));
		expect(generic.error).toBe('Du bist schon auf 25 Listen');
	});

	it('falls back to the generic message for a non-Error rejection', async () => {
		const action = new AsyncAction();
		// A non-Error rejection is exactly what this test is about, hence the
		// disable: it must not be stringified.
		// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
		await action.run(() => Promise.reject('a bare string'));
		expect(action.error).toBe(GENERIC());
	});
});

describe("AsyncDialog onClose: 'forget'", () => {
	type Dialog = { kind: 'rename'; listId: string } | { kind: 'leave' };

	it('opens with a clean slate', async () => {
		const dialog = new AsyncDialog<Dialog>({ onClose: 'forget' });
		await dialog.run(() => Promise.reject(new Error('boom')));
		expect(dialog.error).toBeDefined();

		dialog.open({ kind: 'rename', listId: 'l1' });
		expect(dialog.current).toEqual({ kind: 'rename', listId: 'l1' });
		expect(dialog.error).toBeUndefined();
		expect(dialog.busy).toBe(false);
	});

	it('closes on success', async () => {
		const dialog = new AsyncDialog<Dialog>({ onClose: 'forget' });
		dialog.open({ kind: 'leave' });
		await dialog.run(() => Promise.resolve());
		expect(dialog.current).toBeNull();
	});

	it('STAYS OPEN on failure, with the error to render inside it', async () => {
		// The invariant the whole class exists for. These surfaces were
		// window.confirm once, which resolved before the mutation ran — so a
		// failure had nowhere to render but a toast aimed at a dismissed dialog.
		const dialog = new AsyncDialog<Dialog>({ onClose: 'forget' });
		dialog.open({ kind: 'leave' });
		await dialog.run(() => Promise.reject(new Error('offline')));

		expect(dialog.current).toEqual({ kind: 'leave' });
		expect(dialog.error).toBe(GENERIC());
		expect(dialog.busy).toBe(false);
	});

	// [D-293] Back, Escape or the backdrop dismiss a sheet while its request
	// runs: the user left, so its late answer must not act on what is open now.
	it('disowns a request when the dialog is dismissed while it runs', async () => {
		const dialog = new AsyncDialog<Dialog>({ onClose: 'forget' });
		let finish: (v: string) => void = () => {};
		dialog.open({ kind: 'leave' });
		const pending = dialog.run(() => new Promise<string>((r) => (finish = r)));

		dialog.close();
		dialog.open({ kind: 'rename', listId: 'list-1' });
		finish('list-9');

		expect(await pending).toEqual({ ok: false });
		// The next dialog stays open, idle, without the old request's outcome.
		expect(dialog.current).toEqual({ kind: 'rename', listId: 'list-1' });
		expect(dialog.busy).toBe(false);
		expect(dialog.error).toBeUndefined();
	});

	it('shows no error for a dismissed request that failed', async () => {
		const dialog = new AsyncDialog<Dialog>({ onClose: 'forget' });
		let fail: (e: Error) => void = () => {};
		dialog.open({ kind: 'leave' });
		const pending = dialog.run(() => new Promise<void>((_, reject) => (fail = reject)));

		dialog.close();
		fail(new Error('offline'));

		expect(await pending).toEqual({ ok: false });
		expect(dialog.error).toBeUndefined();
	});

	it('lets the caller branch on a void mutation', async () => {
		// `Attempt` is a union rather than `T | undefined` precisely so a void
		// mutation can still be branched on: submitLeave navigates away on
		// success and must stay put on failure.
		const dialog = new AsyncDialog<Dialog>({ onClose: 'forget' });
		const navigate = vi.fn();

		if ((await dialog.run(() => Promise.resolve())).ok) navigate();
		expect(navigate).toHaveBeenCalledTimes(1);

		if ((await dialog.run(() => Promise.reject(new Error('no')))).ok) navigate();
		expect(navigate).toHaveBeenCalledTimes(1);
	});
});

// The settings prompts: the run outlives a close, unlike a forgetting dialog's.
describe("AsyncDialog onClose: 'finish'", () => {
	it('clears an old error on open while idle, and closes on success', async () => {
		const sheet = new AsyncDialog<string>({ onClose: 'finish' });
		await sheet.run(() => Promise.reject(new Error('boom')));
		expect(sheet.error).toBeDefined();

		sheet.open('pk-1');
		expect(sheet.current).toBe('pk-1');
		expect(sheet.error).toBeUndefined();
		await sheet.run(() => Promise.resolve());
		expect(sheet.current).toBeNull();
	});

	it('does not disown a run when cancelled, and reopens on it busy', async () => {
		const sheet = new AsyncDialog<true>({ onClose: 'finish' });
		let finish: () => void = () => {};
		sheet.open(true);
		const pending = sheet.run(() => new Promise<void>((r) => (finish = r)));

		sheet.close();
		expect(sheet.current).toBeNull();
		sheet.open(true);
		expect(sheet.busy).toBe(true);

		finish();
		expect(await pending).toEqual({ ok: true, value: undefined });
		expect(sheet.current).toBeNull();
		expect(sheet.busy).toBe(false);
	});
});

// [D-293] A failure says what the user can do about it, in their language:
// the server's and the SDK's messages are English.
describe('failureMessage', () => {
	const response = (status: number, message: string) =>
		Object.assign(new Error(message), { status });

	it('names a lost connection, an expired session and a rate limit', () => {
		expect(failureMessage(response(0, 'Something went wrong.'))).toBe(t('common_error_connection'));
		expect(
			failureMessage(response(401, 'The request requires valid record authorization token.'))
		).toBe(t('common_error_session'));
		expect(failureMessage(response(429, 'Too many attempts, slow down.'))).toBe(
			t('common_error_rate_limited')
		);
	});

	it("never shows a server's own message", () => {
		expect(failureMessage(response(500, 'Failed to mint invite.'))).toBe(GENERIC());
		expect(failureMessage(response(403, 'Not a member of this list.'))).toBe(GENERIC());
	});

	it("reads a browser's failed fetch as a lost connection, and nothing else as one", () => {
		expect(failureMessage(new TypeError('Load failed'))).toBe(t('common_error_connection'));
		expect(failureMessage(new TypeError('Failed to fetch'))).toBe(t('common_error_connection'));
		expect(failureMessage(new TypeError("can't access property 'x' of undefined"))).toBe(GENERIC());
	});

	it("shows the app's own message only as a LocalizedError", () => {
		expect(failureMessage(new LocalizedError('Passkey abgebrochen'))).toBe('Passkey abgebrochen');
		expect(failureMessage(new Error('Passkey abgebrochen'))).toBe(GENERIC());
	});
});
