// Timestamps relative to now, as the rows and the sync health carry them.

export const DAY_MS = 86_400_000;

/** The ISO time `ms` before `from`, by default now. */
export const isoAgo = (ms: number, from: number = Date.now()): string =>
	new Date(from - ms).toISOString();

/** The ISO time `n` days ago. */
export const daysAgo = (n: number): string => isoAgo(n * DAY_MS);
