/**
 * German umlauts and ß spelled out (ä→ae, ö→oe, ü→ue, ß→ss), on LOWERCASE
 * input. For looser comparisons and file names, never inside
 * `#lib/normalize.js` ([D-44]).
 */
export function foldUmlauts(lower: string): string {
	return lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}
