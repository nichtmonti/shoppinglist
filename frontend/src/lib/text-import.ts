// A shopping list someone pasted or shared as plain text ([D-254]): what
// "Die Einkaufsliste" sends when a list is shared, what Mealie and Tandoor
// copy, and what most other apps, notes and chats produce. Pure: text in,
// entries out. Where each entry lands and whether the target list already has
// it is text-import-plan.ts's job.
//
// The shape it reads:
//
//   Hamburg               ← a title, only above a sectioned or marked list
//
//   [Obst - Gemüse]       ← a section ("[…]" alone on its line, "# …", or
//                           "Obst:" over items)
//   Mango                 ← one item per line
//   - Paprika, rot        ← bullets, numbers and checkboxes are stripped
//   ☑ Brot                ← a ticked one is read as already bought
//   1 kg Kartoffeln       ← a leading amount is the quantity (Mealie, Tandoor)
//   Zwiebeln (3)          ← and so is a trailing one in brackets (OurGroceries)
//
//   Milchprodukte         ← an unindented line over indented ones is a
//    1 l Milch               section too (Tandoor's Markdown list)
//
// Nothing else is inferred. A line is one item's name, commas and all
// ("Paprika, rot"), and an amount is only read off where it cannot be part of
// the name: a number of at most three digits followed by a space, or any
// number with a unit ("7up" and "4711 Echt Kölnisch Wasser" stay names).

import { cleanSpaces, splitQuantity } from './amount';
import { t } from './i18n';

/** A text's lines, whichever of the three line ends it uses. */
export function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

export interface TextEntry {
	name: string;
	/** The amount the line carried, as written ("1 kg", "3"); '' for none. Free text, [D-20]. */
	quantity: string;
	/** The section header the line sat under, as written; null above the first. */
	section: string | null;
	/** Marked as ticked in the source (☑, ✓, [x]). */
	checked: boolean;
}

export interface ParsedText {
	/** The list's name, when the text carries one (see `titleOf`). */
	title: string | null;
	entries: TextEntry[];
	/** The text ran past MAX_TEXT_LENGTH: only its whole lines before that were read. */
	cut: boolean;
}

/** The most text the paste field and a share accept (characters). */
export const MAX_TEXT_LENGTH = 100_000;

/**
 * Text that is a file rather than a list ([D-254]): read line by line it would
 * make an item of every row or brace, so the screen says what it is instead.
 * `backup` is this app's own backup document, which is imported as one.
 */
export type StructuredKind = 'backup' | 'json' | 'markup' | 'table' | 'csv' | 'yaml';

/**
 * Why text of `kind` is not read as a list, and what to do instead; null for
 * a backup the screen imports. A backup pasted on a list's own import
 * (`onList`) is refused: it makes a new list, never a merge ([D-72]).
 */
export function structuredProblem(kind: StructuredKind, onList: boolean): string | null {
	switch (kind) {
		case 'backup':
			return onList ? t('import_backup_elsewhere') : null;
		case 'json':
			return t('import_format_json');
		case 'markup':
			return t('import_format_markup');
		case 'table':
			return t('import_format_table');
		case 'csv':
			return t('import_format_csv');
		case 'yaml':
			return t('import_format_yaml');
	}
}

/** The share of non-blank lines a shape must hold for, beyond the first. */
const MOST = 0.8;

/** How many `delimiter`s a CSV line has outside double quotes. */
function fieldBreaks(line: string, delimiter: string): number {
	let n = 0;
	let quoted = false;
	for (const ch of line) {
		if (ch === '"') quoted = !quoted;
		else if (ch === delimiter && !quoted) n++;
	}
	return n;
}

/**
 * What kind of file `text` is, or null for a list. Each test asks for a shape
 * no shopping list has by accident: JSON that parses, markup from its first
 * to its last character, a Markdown table's pipes, CSV's equal column count on
 * every line (three columns at least, so "Paprika, rot" is still an item),
 * and YAML's document start or its nested keys.
 */
export function detectStructured(text: string, backupFormat: string): StructuredKind | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	if (/^[[{]/.test(trimmed)) {
		try {
			const value: unknown = JSON.parse(trimmed);
			if (typeof value === 'object' && value !== null) {
				const format = (value as Record<string, unknown>).format;
				return format === backupFormat ? 'backup' : 'json';
			}
		} catch {
			// "[Obst]\nMango" is a list with a section, not broken JSON.
		}
	}
	if (/^<[!?a-zA-Z]/.test(trimmed) && trimmed.endsWith('>')) return 'markup';

	const lines = splitLines(trimmed).filter((l) => l.trim());
	if (lines.length < 2) return null;

	const piped = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
	if (piped >= 2 && piped >= lines.length * MOST) return 'table';

	// Two lines with the same commas are a coincidence („Brot, Butter, Käse“
	// over „Äpfel, Birnen, Bananen“); an export has a header and rows.
	for (const [delimiter, least] of [
		[',', 2],
		[';', 2],
		['\t', 1]
	] as const) {
		const breaks = fieldBreaks(lines[0], delimiter);
		if (
			lines.length >= 3 &&
			breaks >= least &&
			lines.every((l) => fieldBreaks(l, delimiter) === breaks)
		) {
			return 'csv';
		}
	}

	// Nested means an indented key: „Einkauf:“ over „Milch: 2“ is a list.
	const key = /^(\s*)(?:-\s+)?[A-Za-z_][\w.-]*:(?:\s|$)/;
	const keyed = lines.map((l) => key.exec(l));
	const nested = keyed.some((m) => m && m[1].length > 0);
	if (
		lines[0].trim() === '---' ||
		(nested && keyed.filter(Boolean).length >= lines.length * MOST)
	) {
		return 'yaml';
	}
	return null;
}

const SECTION_BRACKET = /^\[([^\]]+)\]$/;
const SECTION_HASH = /^#{1,6}\s+(.+)$/;
const CHECKED_MARK = /^(?:[☑☒✓✔✅]\uFE0F?|\[[xX]\])\s*/u;
const UNCHECKED_MARK = /^(?:[☐□▢◻⬜]\uFE0F?|\[ \])\s*/u;
const BULLET = /^(?:[-*+•·–—◦○●▪‣]|\d{1,3}[.)])\s+/u;
// What WhatsApp and Telegram Desktop put before each message when several are
// copied: „[12.10.25, 18:03] Anna: “, „[10/12/25, 6:03 PM] Anna: “ (WhatsApp),
// „[12.10.26 18:03] Anna: “ (Telegram).
const CHAT_PREFIX =
	/^\[\d{1,2}[./]\d{1,2}[./]\d{2,4},? \d{1,2}:\d{2}(?::\d{2})?(?: ?[AaPp]\.? ?[Mm]\.?)?\] [^:]{1,40}: /u;

function sectionOf(line: string): string | null {
	const m = SECTION_BRACKET.exec(line) ?? SECTION_HASH.exec(line);
	return m ? cleanSpaces(m[1]) || null : null;
}

type Line =
	| { kind: 'blank' }
	| { kind: 'section'; name: string }
	| {
			kind: 'item';
			name: string;
			quantity: string;
			checked: boolean;
			marked: boolean;
			/** The raw line started with whitespace. */
			indented: boolean;
	  };

function classifyLine(raw: string): Line {
	const line = cleanSpaces(raw).replace(CHAT_PREFIX, '');
	if (!line) return { kind: 'blank' };
	const section = sectionOf(line);
	if (section) return { kind: 'section', name: section };

	let rest = line;
	let checked = false;
	let marked = false;
	const bullet = BULLET.exec(rest);
	if (bullet) {
		rest = rest.slice(bullet[0].length);
		marked = true;
	}
	const done = CHECKED_MARK.exec(rest);
	const open = done ? null : UNCHECKED_MARK.exec(rest);
	if (done || open) {
		rest = rest.slice((done ?? open)![0].length);
		checked = done !== null;
		marked = true;
	}
	const { name, quantity } = splitQuantity(rest.trim());
	return { kind: 'item', name, quantity, checked, marked, indented: /^[ \t\u00a0]/u.test(raw) };
}

/**
 * The two shapes where a list says "section" without brackets, each only for
 * an unmarked line with no amount of its own, so "2 Äpfel" stays an item:
 * a line ending in a colon over an item („Obst:“, „Rewe:“), since no item's
 * name ends in one; and an unindented line that opens a block (first, or after
 * a blank line) directly over indented items (Tandoor's Markdown list writes
 * its categories so, its items behind a space), where a stray leading space
 * mid-list makes no heading of the line above it.
 */
function bareHeadings(lines: Line[]): Line[] {
	return lines.map((line, i) => {
		const next = lines[i + 1];
		// „Obst:“ or „Rewe:“ over items: no item's name ends in a colon.
		if (
			line.kind === 'item' &&
			!line.marked &&
			!line.quantity &&
			/^.*[^:\s]:$/u.test(line.name) &&
			next?.kind === 'item'
		) {
			return { kind: 'section', name: line.name.slice(0, -1).trim() };
		}
		if (line.kind !== 'item' || line.indented || line.marked || line.quantity) return line;
		const before = lines[i - 1];
		if (before && before.kind !== 'blank') return line;
		if (next?.kind !== 'item' || !next.indented) return line;
		return { kind: 'section', name: line.name };
	});
}

/**
 * Whether the first line names the list rather than being its first item.
 * Only when the rest of the text shows it is a different kind of line: it
 * stands above a section header, or it is unmarked above items that carry a
 * bullet or a checkbox. A plain "Milch / Brot / Eier" paste has no title, so
 * no item is ever taken for one.
 */
function titleOf(lines: Line[]): string | null {
	const firstAt = lines.findIndex((l) => l.kind !== 'blank');
	const first = lines[firstAt];
	if (first?.kind !== 'item' || first.marked || first.quantity || !first.name) return null;
	const rest = lines.slice(firstAt + 1).filter((l) => l.kind !== 'blank');
	const next = rest[0];
	if (!next) return null;
	if (next.kind === 'section') return first.name;
	const items = rest.filter((l) => l.kind === 'item');
	return items.length > 0 && items.every((l) => l.kind === 'item' && l.marked) ? first.name : null;
}

export function parseTextList(text: string): ParsedText {
	// Past the cap, the line it falls in is dropped whole, not read as „Kartof“.
	const cut = text.length > MAX_TEXT_LENGTH;
	const kept = cut ? text.slice(0, MAX_TEXT_LENGTH).replace(/[^\r\n]*$/, '') : text;
	const lines = bareHeadings(splitLines(kept).map(classifyLine));
	const title = titleOf(lines);
	let skipTitle = title !== null;

	const entries: TextEntry[] = [];
	let section: string | null = null;
	for (const line of lines) {
		if (line.kind === 'blank') continue;
		if (line.kind === 'section') {
			section = line.name;
			continue;
		}
		if (skipTitle) {
			skipTitle = false;
			continue;
		}
		if (line.name) {
			entries.push({ name: line.name, quantity: line.quantity, section, checked: line.checked });
		}
	}
	return { title, entries, cut };
}
