/**
 * What an overlay shows: the value it is open on, and after a close (the value
 * going null) the one it last showed. A dialog or sheet stays mounted and
 * bits-ui animates it out once `open` is false; this keeps its content there
 * meanwhile, where content read off the open value would empty first.
 * Svelte and bits-ui have no such state of their own.
 */
export class Kept<T> {
	#read: () => T | null;
	#last: T | null = null;

	/**
	 * The latest non-null value of `read` that was read here; null until
	 * then. The overlay's markup reads it on every change, so it is what the
	 * overlay last showed.
	 */
	readonly value: T | null = $derived.by(() => (this.#last = this.#read() ?? this.#last));

	/** @param read the value the overlay is open on, null while closed. */
	constructor(read: () => T | null) {
		this.#read = read;
	}
}
