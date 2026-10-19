// localStorage access that never throws. Storage can be disabled (private
// modes, blocked site data) or full; every caller here keeps a convenience in
// it, so a failed read is "nothing stored" and a failed write is dropped.

export function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// disabled or full: the caller's fallback applies
	}
}

/**
 * A value this tab keeps across a reload, as Safari does to a tab in the
 * background ([D-292]): sessionStorage, which closing the tab drops, never the
 * URL or history. Memory holds it where storage refuses the write.
 */
export function tabValue(key: string): {
	get(): string | null;
	set(value: string): void;
	clear(): void;
} {
	let unstored: string | null = null;
	return {
		get() {
			if (unstored !== null) return unstored;
			try {
				return sessionStorage.getItem(key);
			} catch {
				return null;
			}
		},
		set(value) {
			try {
				sessionStorage.setItem(key, value);
				unstored = null;
			} catch {
				// disabled or full: kept until the page goes
				unstored = value;
			}
		},
		clear() {
			unstored = null;
			try {
				sessionStorage.removeItem(key);
			} catch {
				// disabled: nothing was stored
			}
		}
	};
}
