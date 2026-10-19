// A sheet open on one row of a live list (§9.1), held by id and re-derived off
// the live rows. A row that leaves the source under the open sheet closes it
// for good: it must not reopen by itself if the row comes back. Construct it
// during component init: the close is an effect.
export class LiveSelection<T extends { id: string }> {
	#source: () => T[];

	/** The open row's id, or null for no sheet. */
	id = $state<string | null>(null);

	/** The open row as the source holds it now, or null. */
	item: T | null = $derived(this.#find(this.id));

	/** @param source the rows the sheet may be open on, live. */
	constructor(source: () => T[]) {
		this.#source = source;
		$effect(() => {
			if (this.id !== null && !this.item) this.id = null;
		});
	}

	#find(id: string | null): T | null {
		return id === null ? null : (this.#source().find((row) => row.id === id) ?? null);
	}

	open = (id: string): void => {
		this.id = id;
	};

	close = (): void => {
		this.id = null;
	};
}
