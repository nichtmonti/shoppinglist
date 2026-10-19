// Design proposals the gallery can show under the current app ([D-117]).
//
// A comparison is one row of the same production components with a small CSS
// delta, in comparisons/<id>.css (imported by LiveGallery) and scoped to
// `[data-variant='<id>']`, so nothing here forks a component. Each names the
// decision waiting on it. When one is decided, ship it in the app or drop it,
// and remove the entry and its stylesheet: git keeps the history, and the
// gallery shows only what is still open.

export interface Comparison {
	id: string;
	title: string;
	/** What the proposal changes, in a line. */
	note: string;
	/** The decision the proposal belongs to. */
	decision: string;
}

export const COMPARISONS: readonly Comparison[] = [
	{
		id: 'layout',
		title: 'Vorschlag · Lange Mengen',
		note: 'Mengen brechen um statt abzuschneiden · Bearbeiten-Zeilen unter 19rem zweizeilig',
		decision: 'D-117'
	}
];

/** The app as it ships: always the first row, and the harnesses' target. */
export const CURRENT = {
	id: 'current',
	title: 'Aktuelle App',
	note: 'Unveränderte Produktionskomponenten und -styles'
} as const;
