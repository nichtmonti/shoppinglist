// "Run a mutation, keep the surface open while it fails", for every online-only
// action (§7.5/§7.6/§9.3). A surface closes only on success, so a failure has
// the still-open surface to render in.
import { reportUncaught } from '#lib/client-errors.js';
import { failureMessage, isAppError } from '#lib/failure-message.js';

/**
 * The outcome of one attempt; a union rather than `T | undefined` so a void
 * mutation can still be branched on.
 */
export type Attempt<T> = { ok: true; value: T } | { ok: false };

/** One in-flight mutation's `busy` + `error`, with the try/catch that drives them. */
export class AsyncAction {
	busy = $state(false);
	error = $state<string | undefined>(undefined);
	// The latest run owns `busy` and `error`; a reset disowns the one in flight
	// ([D-293]).
	#run = 0;

	/** Back to idle with no error; a run still in flight no longer counts. */
	reset(): void {
		this.#run++;
		this.busy = false;
		this.error = undefined;
	}

	/**
	 * Run `fn` with `busy` held, mapping a rejection onto `error`. Never
	 * rethrows: the failure is rendered, not propagated. A run that was reset
	 * or overtaken meanwhile reports `ok: false` and touches nothing: what it
	 * did happened, but the user has left the surface that asked for it.
	 */
	async run<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
		const run = ++this.#run;
		this.busy = true;
		this.error = undefined;
		try {
			const value = await fn();
			if (run !== this.#run) return { ok: false };
			this.busy = false;
			return { ok: true, value };
		} catch (e) {
			// The app's own error, no answer of a server's (a TypeError, a
			// database that refused), says only "Something went wrong" on
			// screen: its cause goes to the server log.
			if (isAppError(e)) reportUncaught(e, 'action');
			if (run !== this.#run) return { ok: false };
			this.error = failureMessage(e);
			this.busy = false;
			return { ok: false };
		}
	}
}

export interface AsyncDialogOptions {
	/**
	 * What closing the dialog does to a request still in flight ([D-293]).
	 * Nothing is undone either way: what the server took happened.
	 *
	 * - `forget`: its answer is ignored, so a late success neither navigates
	 *   nor closes the next dialog, and a late failure has nowhere to show.
	 *   For what sync brings to the screen anyway (lists, items, members).
	 * - `finish`: its answer still counts, and its success still reloads what
	 *   it changed. For what sync does not carry (the nickname, passkeys): a
	 *   passkey ceremony that went through would otherwise stay unlisted.
	 *   Reopened mid-run, the dialog shows that run as busy.
	 */
	onClose: 'forget' | 'finish';
}

/**
 * An `AsyncAction` that also owns which dialog is open. `K` is the caller's
 * union of open-dialog shapes (see the home's `HomeDialog`), so a dialog's
 * parameters travel with the flag instead of in variables cleared in step.
 */
export class AsyncDialog<K> extends AsyncAction {
	/** The open dialog, or null for none. */
	current = $state<K | null>(null);
	#forgetOnClose: boolean;

	constructor(options: AsyncDialogOptions) {
		super();
		this.#forgetOnClose = options.onClose === 'forget';
	}

	/** Opens on `next`, clearing an old error unless a kept run is still busy. */
	open(next: K): void {
		if (this.#forgetOnClose || !this.busy) this.reset();
		this.current = next;
	}

	close(): void {
		this.current = null;
		if (this.#forgetOnClose) this.reset();
	}

	/** As `AsyncAction.run`, and closes the dialog only if it worked. */
	override async run<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
		const attempt = await super.run(fn);
		if (attempt.ok) this.close();
		return attempt;
	}
}
