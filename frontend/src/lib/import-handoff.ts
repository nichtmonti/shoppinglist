// [D-271] Text pasted into a list's add field, carried to that list's import
// review: never in the URL, the history or the server's request log
// ([D-254]). The tab keeps it until the review is left, so a reload still has
// it ([D-292]).
import { tabValue } from './safe-storage';
import { splitLines } from './text-import';

const pending = tabValue('import-handoff');

/** Leaves `text` for the next import screen to start from. */
export function handOffImport(text: string): void {
	pending.set(text);
}

/** What was handed off, until `clearImportHandoff()`. */
export function importHandoff(): string {
	return pending.get() ?? '';
}

/** The review was left: the next one starts empty. */
export function clearImportHandoff(): void {
	pending.clear();
}

/** Whether a paste is a list rather than a name: two lines or more with text. */
export function isPastedList(text: string): boolean {
	return splitLines(text).filter((line) => line.trim()).length >= 2;
}
