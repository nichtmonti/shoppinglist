// Deployment configuration the SPA reads from the <meta name> tags the server
// stamps into its shell (backend/internal/ui says why not an API route). They
// are present offline too and fixed for the document's life, so each is a
// plain constant.
//
// EVERY value is validated again against the server's own bounds: the client
// cannot tell a shell its server stamped from one an old service worker cached
// or a proxy rewrote. An unusable value falls back to the compiled default.
//
// The meta names and the default source link come from the JSON internal/ui
// embeds, so the two ends cannot spell them differently.
import shell from '../../../backend/internal/ui/shell-meta.json';
import { MAX_BACKUP_ITEMS, MAX_ITEMS_PER_LIST } from './field-contract';

/** A bounded whole number, or null for anything else: absent, blank, not a
 *  number, fractional, or out of range. Null means "use the default". */
function boundedInt(
	raw: string | null | undefined,
	{ min, max }: { min: number; max: number }
): number | null {
	const text = (raw ?? '').trim();
	// Not parseInt, which reads '3am' as 3 and makes a typo look configured.
	if (!/^-?\d+$/.test(text)) return null;
	const value = Number(text);
	return value >= min && value <= max ? value : null;
}

/** The content of one of the shell's <meta name> tags. `globalThis.document`
 *  so prerendering (no DOM) gets the defaults instead of throwing. */
function shellMeta(name: string): string | null | undefined {
	return globalThis.document?.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
}

// ---- the release ([D-181]) ------------------------------------------------

/** A version as the server stamps it ("v0.5.0 (abc1234)", "dev"), or null for
 *  anything absent (a Vite-served shell) or implausible. */
export function parseAppVersion(raw: string | null | undefined): string | null {
	const text = (raw ?? '').trim();
	return text && text.length <= 64 && /^[\w.+\-() ]+$/.test(text) ? text : null;
}

/** This build's release, resolved once at module load; null outside a
 *  server-stamped shell. */
export const appVersion: string | null = parseAppVersion(shellMeta(shell.version_meta));

// ---- the source link ([D-211]) ---------------------------------------------

/** This project's repository, for a shell the server did not stamp. */
export const DEFAULT_SOURCE_URL: string = shell.default_source_url;

/** The stamped source URL when it is an http(s) URL, else the default: a link
 *  the app renders must not be able to carry another scheme. */
export function parseSourceUrl(raw: string | null | undefined): string {
	const text = (raw ?? '').trim();
	return /^https?:\/\/\S+$/i.test(text) ? text : DEFAULT_SOURCE_URL;
}

/** Where this instance's source is; the AGPL requires offering it (§14). */
export const sourceUrl: string = parseSourceUrl(shellMeta(shell.source_meta));

// ---- the per-list items cap ([D-217]) -------------------------------------

/** A stamped cap (a whole number ≥ 1, the server's boot rule), or null for
 *  "the compiled default". */
export function parseMaxItemsPerList(raw: string | null | undefined): number | null {
	return boundedInt(raw, { min: 1, max: Number.MAX_SAFE_INTEGER });
}

/** This instance's moved per-list cap, or null where left at the default
 *  (the meta tag is absent then). */
export const maxItemsPerList: number | null = parseMaxItemsPerList(
	shellMeta(shell.max_items_per_list_meta)
);

/** How many rows a list may hold on this instance, tombstones included: the
 *  push route refuses a create past it ([D-217]). */
export const LIST_MAX_ITEMS: number = maxItemsPerList ?? MAX_ITEMS_PER_LIST;

/** How many items one backup may bring on this instance ([D-217]): the same
 *  number the import route checks (internal/listcap.ImportMax). */
export const IMPORT_MAX_ITEMS: number = Math.min(
	MAX_BACKUP_ITEMS,
	maxItemsPerList ?? MAX_BACKUP_ITEMS
);

// ---- the barcode scanner ([D-218]) ----------------------------------------

/** Off only for an explicit "off" in the scanner's meta tag; a missing or unrecognised value keeps the
 *  scan button, matching the server's default. */
export function parseScannerEnabled(raw: string | null | undefined): boolean {
	return (raw ?? '').trim().toLowerCase() !== 'off';
}

/** Whether this instance offers the scan button. */
export const scannerEnabled: boolean = parseScannerEnabled(shellMeta(shell.scanner_meta));
